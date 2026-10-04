import asyncio
import os
import re
from datetime import datetime, timedelta, timezone
from functools import wraps

import psycopg
from jose import JWTError, jwt
from passlib.context import CryptContext
from quart import Quart, jsonify, request

from db import SCHEMA, connect
from rules import judge

SECRET = os.environ.get("JWT_SECRET", "yaw-align-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "technician": {
        "role": "writer",
        "password_hash": pwd.hash("tech123456"),
    },
    "observer": {
        "role": "reader",
        "password_hash": pwd.hash("obs123456"),
    },
}

SERIAL_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-]{1,39}$")

app = Quart(__name__)


def _run_db(fn, *args, **kwargs):
    return fn(*args, **kwargs)


async def run_db(fn, *args, **kwargs):
    return await asyncio.to_thread(_run_db, fn, *args, **kwargs)


class ApiError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def normalize_serial(raw):
    serial = (raw or "").strip().upper()
    if not serial:
        raise ApiError(400, "桨叶出厂号不能为空（须点选在役号）")
    if not SERIAL_RE.match(serial):
        raise ApiError(400, "桨叶出厂号格式不合法（2-40 位大写字母、数字或短横线）")
    return serial


def seed_if_empty(conn):
    conn.execute(SCHEMA)
    blade_n = conn.execute("SELECT COUNT(*) AS n FROM blade_serials").fetchone()["n"]
    log_n = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if blade_n > 0 or log_n > 0:
        return
    now = datetime.now(timezone.utc)

    in_service = ["BLADE-001", "BLADE-002", "BLADE-003", "BLADE-004", "BLADE-005"]
    to_retire = ["BLADE-006", "BLADE-099"]
    for serial in in_service + to_retire:
        conn.execute(
            """INSERT INTO blade_serials
               (serial, status, registered_by, registered_at)
               VALUES (%s, 'in_service', %s, %s)""",
            (serial, "technician", now),
        )

    samples = [
        ("W01", 0.4, "合格", "BLADE-001"),
        ("W07", 3.2, "偏航超差", "BLADE-006"),
    ]
    for code, err, expected_verdict, serial in samples:
        verdict, reason = judge(err)
        assert verdict == expected_verdict
        conn.execute(
            """INSERT INTO yaw_logs
               (turbine_code, yaw_err_deg, status, verdict, reason,
                blade_serial, created_by, created_at, processed_at)
               VALUES (%s, %s, 'done', %s, %s, %s, %s, %s, %s)""",
            (code, err, verdict, reason, serial, "technician", now, now),
        )

    # BLADE-006 已绑旧单后退役：旧单保留原号；BLADE-099 未绑定直接退役
    for serial in to_retire:
        conn.execute(
            """UPDATE blade_serials
                  SET status = 'retired', retired_by = %s, retired_at = %s
                WHERE serial = %s""",
            ("technician", now, serial),
        )


@app.before_serving
async def startup():
    def init():
        with connect() as conn:
            seed_if_empty(conn)
            conn.commit()

    await run_db(init)


def parse_bearer():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


async def current_user():
    token = parse_bearer()
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except JWTError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_login(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        return await handler(user, *args, **kwargs)

    return wrapper


def require_writer(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        if user["role"] != "writer":
            return jsonify({"detail": "仅现场技师可维护名册与提交报送"}), 403
        return await handler(user, *args, **kwargs)

    return wrapper


@app.get("/api/health")
async def health():
    return jsonify({"status": "ok", "service": "yaw-align-log"})


@app.post("/api/auth/login")
async def login():
    body = await request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return jsonify({"detail": "用户名或密码错误"}), 401
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return jsonify(
        {
            "access_token": token,
            "username": username,
            "role": user["role"],
        }
    )


@app.get("/api/logs")
@require_login
async def list_logs(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT id, turbine_code, yaw_err_deg, status, verdict, reason,
                          blade_serial, created_by, created_at, processed_at
                   FROM yaw_logs ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


def _serial_rows(conn):
    return conn.execute(
        """SELECT serial, status, registered_by, registered_at,
                  retired_by, retired_at
             FROM blade_serials
         ORDER BY serial"""
    ).fetchall()


def _binding_map(conn):
    rows = conn.execute(
        """SELECT id, turbine_code, status, blade_serial, created_at
             FROM yaw_logs
            WHERE blade_serial IS NOT NULL
         ORDER BY id DESC"""
    ).fetchall()
    bindings = {}
    for row in rows:
        bindings.setdefault(row["blade_serial"], []).append(
            {
                "id": row["id"],
                "turbine_code": row["turbine_code"],
                "status": row["status"],
                "created_at": row["created_at"],
            }
        )
    return bindings


@app.get("/api/blades")
@require_login
async def list_blades(user):
    def query():
        with connect() as conn:
            rows = _serial_rows(conn)
            bindings = _binding_map(conn)
            for row in rows:
                row["bound_logs"] = bindings.get(row["serial"], [])
            return {
                "in_service": [r for r in rows if r["status"] == "in_service"],
                "retired": [r for r in rows if r["status"] == "retired"],
            }

    result = await run_db(query)
    return jsonify(result)


@app.get("/api/blades/history")
@require_login
async def blade_history(user):
    serial = request.args.get("serial")
    serial = serial.strip().upper() if serial else None

    def query():
        with connect() as conn:
            if serial:
                return conn.execute(
                    """SELECT id, serial, event_type, actor, event_at, log_id, detail
                         FROM blade_serial_events
                        WHERE serial = %s
                     ORDER BY id DESC LIMIT 200""",
                    (serial,),
                ).fetchall()
            return conn.execute(
                """SELECT id, serial, event_type, actor, event_at, log_id, detail
                     FROM blade_serial_events
                 ORDER BY id DESC LIMIT 200"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


def _expand_serials(body):
    """支持单号登记与号段登记：{serial} / {serials:[...]} / {prefix,start,end,width}。"""
    serials = []
    raw_list = body.get("serials")
    if isinstance(raw_list, list) and raw_list:
        serials = [str(s) for s in raw_list]
    single = body.get("serial")
    if single:
        serials.append(str(single))

    start, end = body.get("start"), body.get("end")
    if start is not None or end is not None:
        try:
            start_i, end_i = int(start), int(end)
        except (TypeError, ValueError):
            raise ApiError(400, "号段起止必须是整数")
        if start_i > end_i:
            raise ApiError(400, "号段起始不能大于终止")
        if end_i - start_i + 1 > 500:
            raise ApiError(400, "单次登记号段不能超过 500 个")
        width = int(body.get("width") or 3)
        if not 1 <= width <= 8:
            raise ApiError(400, "号段补零位宽须在 1-8 之间")
        prefix = str(body.get("prefix") or "BLADE-")
        serials.extend(f"{prefix}{i:0{width}d}" for i in range(start_i, end_i + 1))

    cleaned = []
    seen = set()
    for raw in serials:
        serial = normalize_serial(raw)
        if serial not in seen:
            seen.add(serial)
            cleaned.append(serial)
    if not cleaned:
        raise ApiError(400, "未提供要登记的出厂号或号段")
    return cleaned


@app.post("/api/blades/register")
@require_writer
async def register_blades(user):
    body = await request.get_json(force=True, silent=True) or {}
    try:
        serials = _expand_serials(body)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status
    now = datetime.now(timezone.utc)

    def insert():
        with connect() as conn:
            try:
                with conn.transaction():
                    existing = conn.execute(
                        "SELECT serial FROM blade_serials WHERE serial = ANY(%s)",
                        (serials,),
                    ).fetchall()
                    if existing:
                        dupes = sorted(r["serial"] for r in existing)
                        raise ApiError(
                            409, f"以下出厂号已在册，整批未登记：{', '.join(dupes)}"
                        )
                    for serial in serials:
                        # 名册行与 registered 履历由触发器在同一事务落齐
                        conn.execute(
                            """INSERT INTO blade_serials
                               (serial, status, registered_by, registered_at)
                               VALUES (%s, 'in_service', %s, %s)""",
                            (serial, user["username"], now),
                        )
                return serials
            except ApiError:
                raise

    try:
        created = await run_db(insert)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status
    return jsonify({"registered": created, "count": len(created)}), 201


@app.post("/api/blades/<serial>/retire")
@require_writer
async def retire_blade(user, serial):
    try:
        serial = normalize_serial(serial)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status
    now = datetime.now(timezone.utc)

    def update():
        with connect() as conn:
            try:
                with conn.transaction():
                    # 行锁串行化退役，防止与报送并发时“校验后落库前被退役”
                    row = conn.execute(
                        "SELECT status FROM blade_serials WHERE serial = %s FOR UPDATE",
                        (serial,),
                    ).fetchone()
                    if row is None:
                        raise ApiError(404, f"出厂号 {serial} 未登记在册")
                    if row["status"] == "retired":
                        raise ApiError(409, f"出厂号 {serial} 已退役，无需重复退役")
                    conn.execute(
                        """UPDATE blade_serials
                              SET status = 'retired', retired_by = %s, retired_at = %s
                            WHERE serial = %s""",
                        (user["username"], now, serial),
                    )
            except ApiError:
                raise

    try:
        await run_db(update)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status
    return jsonify({"serial": serial, "status": "retired"})


@app.post("/api/logs")
@require_writer
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    try:
        yaw_err_deg = float(body.get("yaw_err_deg"))
    except (TypeError, ValueError):
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    # 空选整单退回；不合法格式同样退回
    raw_serial = body.get("blade_serial")
    if raw_serial is None or not str(raw_serial).strip():
        return jsonify({"detail": "须点选在役桨叶出厂号，空选整单退回"}), 400
    try:
        blade_serial = normalize_serial(raw_serial)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status

    now = datetime.now(timezone.utc)

    def insert():
        with connect() as conn:
            try:
                with conn.transaction():
                    # 事务内对名册行加锁复核：未登记 / 已退役一律整单退回。
                    # 触发器会再做一次 FOR UPDATE 校验，旁路写口与落库前换号同样被拒。
                    blade = conn.execute(
                        "SELECT status FROM blade_serials WHERE serial = %s FOR UPDATE",
                        (blade_serial,),
                    ).fetchone()
                    if blade is None:
                        raise ApiError(
                            400, f"桨叶出厂号 {blade_serial} 未登记在册，报送整单退回"
                        )
                    if blade["status"] != "in_service":
                        raise ApiError(
                            400, f"桨叶出厂号 {blade_serial} 已退役，报送整单退回"
                        )
                    row = conn.execute(
                        """INSERT INTO yaw_logs
                           (turbine_code, yaw_err_deg, status, verdict, reason,
                            blade_serial, created_by, created_at)
                           VALUES (%s, %s, 'pending', NULL, NULL, %s, %s, %s)
                           RETURNING id, turbine_code, yaw_err_deg, status, verdict,
                                     reason, blade_serial, created_by, created_at,
                                     processed_at""",
                        (turbine_code, yaw_err_deg, blade_serial,
                         user["username"], now),
                    ).fetchone()
                return row
            except ApiError:
                raise

    try:
        row = await run_db(insert)
    except ApiError as exc:
        return jsonify({"detail": exc.detail}), exc.status
    except (psycopg.errors.ForeignKeyViolation, psycopg.errors.CheckViolation) as exc:
        detail = exc.diag.message_primary or "桨叶出厂号校验失败，报送整单退回"
        return jsonify({"detail": detail}), 400
    return jsonify(row), 201
