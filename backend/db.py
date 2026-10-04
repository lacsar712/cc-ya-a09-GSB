import os

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:app@localhost:54399/yawalign",
)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


# 幂等结构：桨叶出厂号名册 + 变更履历 + 单据绑定外键 + 冻结触发器。
# api 与 worker 启动时都会执行本脚本，新增对象全部 IF NOT EXISTS / OR REPLACE。
SCHEMA = """
CREATE TABLE IF NOT EXISTS blade_serials (
    serial text PRIMARY KEY,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'retired')),
    registered_by text NOT NULL,
    registered_at timestamptz NOT NULL,
    retired_by text,
    retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS blade_serial_history (
    id bigserial PRIMARY KEY,
    serial text NOT NULL,
    action text NOT NULL CHECK (action IN ('register', 'bind', 'retire')),
    log_id integer,
    turbine_code text,
    actor text NOT NULL,
    at timestamptz NOT NULL,
    detail text
);
CREATE INDEX IF NOT EXISTS idx_blade_history_serial
    ON blade_serial_history (serial, id);

CREATE TABLE IF NOT EXISTS yaw_logs (
    id serial PRIMARY KEY,
    turbine_code text NOT NULL,
    yaw_err_deg double precision NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    verdict text,
    reason text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);

ALTER TABLE yaw_logs
    ADD COLUMN IF NOT EXISTS blade_serial text
    REFERENCES blade_serials (serial);

-- 落库前最后一道闸：任何写口（API、未来的批处理、直连 SQL）插入单据时，
-- 绑定号必须存在且在役；防止绕过页面与接口的旁路写入。
CREATE OR REPLACE FUNCTION yaw_logs_blade_active_on_insert() RETURNS trigger AS $$
DECLARE
    v_status text;
BEGIN
    IF NEW.blade_serial IS NULL THEN
        RAISE EXCEPTION '单据必须绑定在役桨叶出厂号，未绑定整单退回'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM blade_serials WHERE serial = NEW.blade_serial;
    IF NOT FOUND THEN
        RAISE EXCEPTION '桨叶出厂号 % 未登记在册', NEW.blade_serial
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_status <> 'active' THEN
        RAISE EXCEPTION '桨叶出厂号 % 已退役，不能绑定新单据（旧单绑定保留）',
            NEW.blade_serial USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_yaw_logs_blade_active_insert ON yaw_logs;
CREATE TRIGGER trg_yaw_logs_blade_active_insert
    BEFORE INSERT ON yaw_logs
    FOR EACH ROW EXECUTE FUNCTION yaw_logs_blade_active_on_insert();

-- 出厂号随单冻结：任何对 yaw_logs.blade_serial 的改写都在库内拒绝，
-- 包括绕开报送页面的直连更新；worker 只改判定字段，不受影响。
CREATE OR REPLACE FUNCTION yaw_logs_blade_freeze() RETURNS trigger AS $$
BEGIN
    IF NEW.blade_serial IS DISTINCT FROM OLD.blade_serial THEN
        RAISE EXCEPTION '桨叶出厂号绑定后随单冻结，不可修改（单据 #%）', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_yaw_logs_blade_freeze ON yaw_logs;
CREATE TRIGGER trg_yaw_logs_blade_freeze
    BEFORE UPDATE ON yaw_logs
    FOR EACH ROW EXECUTE FUNCTION yaw_logs_blade_freeze();
"""
