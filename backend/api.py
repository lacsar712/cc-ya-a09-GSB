import asyncio
import os
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

# 单次号段登记上限，避免误操作灌入超大范围
MAX_RANGE_SPAN = 1000

app = Quart(__name__)


def _run_db(fn, *args, **kwargs):
    return fn(*args, **kwargs)


async def run_db(fn, *args, **kwargs):
    return await asyncio.to_thread(_run_db, fn, *args, **kwargs)


def seed_if_empty(conn):
    conn.execute(SCHEMA)
    count = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if count > 0:
        return
    now = datetime.now(timezone.utc)

    # 名册种子：在役号 BLD-1001..1005（前两个绑定示例单据），退役号 BLD-9001。
    active_serials = [f"BLD-100{i}" for i in range(1, 6)]
    retired_serials = ["BLD-9001"]
    for serial in active_serials:
        conn.execute(
            """INSERT INTO blade_serials (serial, status, registered_by, registered_at)
               VALUES (%s, 'active', %s, %s)""",
            (serial, "technician", now),
        )
        conn.execute(
            """INSERT INTO blade_serial_history
                   (serial, action, actor, at, detail)
               VALUES (%s, 'register', %s, %s, %s)""",
            (serial, "technician", now, "种子名册登记"),
        )
    for serial in retired_serials:
        conn.execute(
            """INSERT INTO blade_serials
                   (serial, status, registered_by, registered_at,
                    retired_by, retired_at)
               VALUES (%s, 'retired', %s, %s, %s, %s)""",
            (serial, "technician", now, "technician", now),
        )
        conn.execute(
            """INSERT INTO blade_serial_history
                   (serial, action, actor, at, detail)
               VALUES (%s, 'register', %s, %s, %s)""",
            (serial, "technician", now, "种子名册登记"),
        )
        conn.execute(
            """INSERT INTO blade_serial_history
                   (serial, action, actor, at, detail)
               VALUES (%s, 'retire', %s, %s, %s)""",
            (serial, "technician", now, "种子退役示例"),
        )

    samples = [
        ("W01", 0.4, "合格", "BLD-1001"),
        ("W07", 3.2, "偏航超差", "BLD-1002"),
    ]
    for code, err, expected_verdict, serial in samples:
        verdict, reason = judge(err)
        assert verdict == expected_verdict
        row = conn.execute(
            """INSERT INTO yaw_logs
                   (turbine_code, yaw_err_deg, status, verdict, reason,
                    created_by, created_at, processed_at, blade_serial)
               VALUES (%s, %s, 'done', %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (code, err, verdict, reason, "technician", now, now, serial),
        ).fetchone()
        conn.execute(
            """INSERT INTO blade_serial_history
                   (serial, action, log_id, turbine_code, actor, at, detail)
               VALUES (%s, 'bind', %s, %s, %s, %s, %s)""",
            (serial, row["id"], code, "technician", now, "绑定报送单据"),
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
            return jsonify({"detail": "仅现场技师可执行该操作"}), 403
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
                """SELECT id, turbine_code, blade_serial, yaw_err_deg, status,
                          verdict, reason, created_by, created_at, processed_at
                   FROM yaw_logs ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/logs")
@require_writer
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    blade_serial = (body.get("blade_serial") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    # 报送前桨叶出厂号必须点选；空选整单退回
    if not blade_serial:
        return jsonify({"detail": "请选择在役桨叶出厂号，未绑定出厂号的单据整单退回"}), 400
    try:
        yaw_err_deg = float(body.get("yaw_err_deg"))
    except (TypeError, ValueError):
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    now = datetime.now(timezone.utc)

    def insert():
        # 库内校验，防旁路写口与落库前偷换号：行锁 + 单据插入 + 绑定履历同一事务
        with connect() as conn:
            with conn.transaction():
                blade = conn.execute(
                    """SELECT status FROM blade_serials
                       WHERE serial = %s FOR UPDATE""",
                    (blade_serial,),
                ).fetchone()
                if blade is None:
                    return 404, "桨叶出厂号未登记在册，整单退回"
                if blade["status"] != "active":
                    return 409, "桨叶出厂号已退役，整单退回"
                row = conn.execute(
                    """INSERT INTO yaw_logs
                           (turbine_code, blade_serial, yaw_err_deg, status,
                            verdict, reason, created_by, created_at)
                       VALUES (%s, %s, %s, 'pending', NULL, NULL, %s, %s)
                       RETURNING id, turbine_code, blade_serial, yaw_err_deg,
                                 status, verdict, reason, created_by,
                                 created_at, processed_at""",
                    (turbine_code, blade_serial, yaw_err_deg,
                     user["username"], now),
                ).fetchone()
                # 绑定随单落库的同时写履历，一次落齐
                conn.execute(
                    """INSERT INTO blade_serial_history
                           (serial, action, log_id, turbine_code, actor, at, detail)
                       VALUES (%s, 'bind', %s, %s, %s, %s, %s)""",
                    (blade_serial, row["id"], turbine_code,
                     user["username"], now, "绑定报送单据"),
                )
            conn.commit()
            return 201, row

    try:
        status_code, payload = await run_db(insert)
    except psycopg.Error as exc:
        return jsonify({"detail": f"落库失败：{exc.diag.message_primary or str(exc)}"}), 400
    if status_code != 201:
        return jsonify({"detail": payload}), status_code
    return jsonify(payload), 201


ROSTER_SELECT = """
    SELECT s.serial, s.status, s.registered_by, s.registered_at,
           s.retired_by, s.retired_at,
           (SELECT COUNT(*) FROM yaw_logs l
              WHERE l.blade_serial = s.serial) AS bind_count,
           (SELECT l.id FROM yaw_logs l
              WHERE l.blade_serial = s.serial
              ORDER BY l.id DESC LIMIT 1) AS example_log_id,
           (SELECT l.turbine_code FROM yaw_logs l
              WHERE l.blade_serial = s.serial
              ORDER BY l.id DESC LIMIT 1) AS example_turbine
    FROM blade_serials s
"""


@app.get("/api/blades")
@require_login
async def list_blades(user):
    status = request.args.get("status")
    if status in ("active", "retired"):
        where = "WHERE s.status = %(status)s"
        params = {"status": status}
    else:
        where = ""
        params = {}

    def query():
        with connect() as conn:
            return conn.execute(
                f"{ROSTER_SELECT} {where} ORDER BY s.serial",
                params,
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/blades/register")
@require_writer
async def register_blades(user):
    body = await request.get_json(force=True, silent=True) or {}

    serials: list[str]
    if body.get("serials"):
        raw = body["serials"]
        if not isinstance(raw, list) or not all(isinstance(v, str) for v in raw):
            return jsonify({"detail": "serials 必须是字符串数组"}), 400
        serials = [v.strip() for v in raw if v.strip()]
    else:
        prefix = (body.get("prefix") or "").strip()
        width_raw = body.get("width", 4)
        try:
            start = int(body.get("start"))
            end = int(body.get("end"))
            width = int(width_raw) if width_raw is not None else 4
        except (TypeError, ValueError):
            return jsonify({"detail": "起始号、截止号与位宽必须是整数"}), 400
        if not prefix:
            return jsonify({"detail": "号段前缀不能为空"}), 400
        if start < 0 or end < start or end - start + 1 > MAX_RANGE_SPAN:
            return jsonify(
                {"detail": f"号段范围非法，单次最多登记 {MAX_RANGE_SPAN} 个号"}
            ), 400
        if not 0 <= width <= 12:
            return jsonify({"detail": "位宽需在 0~12 之间"}), 400
        serials = [
            prefix + (str(n).zfill(width) if width else str(n))
            for n in range(start, end + 1)
        ]

    if not serials:
        return jsonify({"detail": "没有可登记的出厂号"}), 400
    if any(len(s) > 64 for s in serials):
        return jsonify({"detail": "出厂号长度不能超过 64 个字符"}), 400
    if len(set(serials)) != len(serials):
        return jsonify({"detail": "号段内存在重复出厂号"}), 400

    now = datetime.now(timezone.utc)

    def register():
        with connect() as conn:
            with conn.transaction():
                # 锁名册后查重，含已退役号：同号永不复用
                existing = conn.execute(
                    """SELECT serial, status FROM blade_serials
                       WHERE serial = ANY(%s) FOR UPDATE""",
                    (serials,),
                ).fetchall()
                if existing:
                    dup = ", ".join(sorted(r["serial"] for r in existing))
                    return 409, f"以下出厂号已在册（含退役号，同号不可复用）：{dup}", None
                conn.execute(
                    """INSERT INTO blade_serials
                           (serial, status, registered_by, registered_at)
                       SELECT s, 'active', %s, %s
                       FROM unnest(%s::text[]) AS s""",
                    (user["username"], now, serials),
                )
                # 名册变更与履历一次落齐
                conn.execute(
                    """INSERT INTO blade_serial_history
                           (serial, action, actor, at, detail)
                       SELECT s, 'register', %s, %s, %s
                       FROM unnest(%s::text[]) AS s""",
                    (user["username"], now,
                     f"号段登记 {len(serials)} 个", serials),
                )
            conn.commit()
            return 201, f"已登记 {len(serials)} 个在役出厂号", serials

    try:
        status_code, message, created = await run_db(register)
    except psycopg.Error as exc:
        return jsonify({"detail": f"登记失败：{exc.diag.message_primary or str(exc)}"}), 400
    return jsonify({"detail": message, "registered": created or []}), status_code


@app.post("/api/blades/<serial>/retire")
@require_writer
async def retire_blade(user, serial):
    serial = serial.strip()
    now = datetime.now(timezone.utc)

    def retire():
        with connect() as conn:
            with conn.transaction():
                blade = conn.execute(
                    "SELECT status FROM blade_serials WHERE serial = %s FOR UPDATE",
                    (serial,),
                ).fetchone()
                if blade is None:
                    return 404, "桨叶出厂号未登记在册"
                if blade["status"] == "retired":
                    return 409, "该出厂号已是退役状态"
                conn.execute(
                    """UPDATE blade_serials
                       SET status = 'retired', retired_by = %s, retired_at = %s
                       WHERE serial = %s""",
                    (user["username"], now, serial),
                )
                # 旧单绑定保留：不更新 yaw_logs，冻结触发器也禁止改写
                conn.execute(
                    """INSERT INTO blade_serial_history
                           (serial, action, actor, at, detail)
                       VALUES (%s, 'retire', %s, %s, %s)""",
                    (serial, user["username"], now, "退役，旧单绑定保留"),
                )
            conn.commit()
            return 200, f"出厂号 {serial} 已退役，历史单据仍保留原绑定"

    try:
        status_code, message = await run_db(retire)
    except psycopg.Error as exc:
        return jsonify({"detail": f"退役失败：{exc.diag.message_primary or str(exc)}"}), 400
    return jsonify({"detail": message, "serial": serial}), status_code


@app.get("/api/blades/<serial>/history")
@require_login
async def blade_history(user, serial):
    def query():
        with connect() as conn:
            blade = conn.execute(
                "SELECT serial, status FROM blade_serials WHERE serial = %s",
                (serial,),
            ).fetchone()
            if blade is None:
                return None
            return conn.execute(
                """SELECT id, serial, action, log_id, turbine_code,
                          actor, at, detail
                   FROM blade_serial_history
                   WHERE serial = %s
                   ORDER BY id DESC""",
                (serial,),
            ).fetchall()

    rows = await run_db(query)
    if rows is None:
        return jsonify({"detail": "桨叶出厂号未登记在册"}), 404
    return jsonify(rows)
