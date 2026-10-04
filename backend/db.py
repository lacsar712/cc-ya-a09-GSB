import os

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:app@localhost:54399/yawalign",
)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


SCHEMA = """
-- 桨叶出厂号名册
CREATE TABLE IF NOT EXISTS blade_serials (
    serial text PRIMARY KEY,
    status text NOT NULL DEFAULT 'in_service'
        CHECK (status IN ('in_service', 'retired')),
    registered_by text NOT NULL,
    registered_at timestamptz NOT NULL,
    retired_by text,
    retired_at timestamptz
);

-- 名册变更履历（登记 / 退役 / 绑定 / 解绑，与名册状态同事务落账）
CREATE TABLE IF NOT EXISTS blade_serial_events (
    id bigserial PRIMARY KEY,
    serial text NOT NULL,
    event_type text NOT NULL
        CHECK (event_type IN ('registered', 'retired', 'bound', 'unbound')),
    actor text NOT NULL,
    event_at timestamptz NOT NULL,
    log_id integer,
    detail text
);
CREATE INDEX IF NOT EXISTS idx_blade_events_serial
    ON blade_serial_events (serial, id);

-- 偏航对中报送单：桨叶出厂号随单冻结
CREATE TABLE IF NOT EXISTS yaw_logs (
    id serial PRIMARY KEY,
    turbine_code text NOT NULL,
    yaw_err_deg double precision NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    verdict text,
    reason text,
    blade_serial text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);
-- 旧库补列
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS blade_serial text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_yaw_logs_blade_serial'
    ) THEN
        ALTER TABLE yaw_logs
            ADD CONSTRAINT fk_yaw_logs_blade_serial
            FOREIGN KEY (blade_serial) REFERENCES blade_serials(serial)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_yaw_logs_blade_serial
    ON yaw_logs (blade_serial);

-- 防“落库后偷换号”：已存在的报送单不允许改绑其它/任何出厂号，
-- 也不允许把已绑定的号清空（仅允许 worker/系统流程外的显式解绑专用路径，
-- 业务上不存在解绑，故这里一律拒绝）。
CREATE OR REPLACE FUNCTION yaw_logs_blade_freeze() RETURNS trigger AS $frozen$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.blade_serial IS DISTINCT FROM OLD.blade_serial THEN
            RAISE EXCEPTION
                '桨叶出厂号 % 已随单冻结，禁止改绑（旧单仍保留原号 %）',
                NEW.id, OLD.blade_serial
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- 任何写口（含旁路 INSERT）都必须绑定“仍在役”的在册桨叶号：
    -- 在事务内对名册行加行锁，挡住“校验通过后、落库前被退役”的竞态。
    IF NEW.blade_serial IS NOT NULL THEN
        PERFORM 1 FROM blade_serials
         WHERE serial = NEW.blade_serial AND status = 'in_service'
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                '桨叶出厂号 % 未登记或已退役，报送整单退回',
                NEW.blade_serial
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;

    -- 绑定/解绑自动落履历，保证“名册变更与履历一次落齐”
    IF TG_OP = 'INSERT' AND NEW.blade_serial IS NOT NULL THEN
        INSERT INTO blade_serial_events
            (serial, event_type, actor, event_at, log_id, detail)
        VALUES (NEW.blade_serial, 'bound', NEW.created_by,
                NEW.created_at, NEW.id,
                '绑定至报送单 #' || NEW.id || '（机组 ' || NEW.turbine_code || '）');
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.blade_serial IS DISTINCT FROM OLD.blade_serial THEN
        IF OLD.blade_serial IS NOT NULL THEN
            INSERT INTO blade_serial_events
                (serial, event_type, actor, event_at, log_id, detail)
            VALUES (OLD.blade_serial, 'unbound', NEW.created_by,
                    NEW.created_at, NEW.id,
                    '自报送单 #' || NEW.id || ' 解绑');
        END IF;
        IF NEW.blade_serial IS NOT NULL THEN
            INSERT INTO blade_serial_events
                (serial, event_type, actor, event_at, log_id, detail)
            VALUES (NEW.blade_serial, 'bound', NEW.created_by,
                    NEW.created_at, NEW.id,
                    '绑定至报送单 #' || NEW.id || '（机组 ' || NEW.turbine_code || '）');
        END IF;
    END IF;

    RETURN NEW;
END;
$frozen$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_yaw_logs_blade_freeze ON yaw_logs;
CREATE TRIGGER trg_yaw_logs_blade_freeze
    BEFORE INSERT OR UPDATE OF blade_serial ON yaw_logs
    FOR EACH ROW EXECUTE FUNCTION yaw_logs_blade_freeze();

-- 退役后不允许“复活”为在役（状态只能 in_service -> retired 单向）
CREATE OR REPLACE FUNCTION blade_serials_guard() RETURNS trigger AS $guard$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'retired' AND NEW.status = 'in_service' THEN
            RAISE EXCEPTION '桨叶出厂号 % 已退役，不能恢复在役', OLD.serial
                USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.status = 'in_service' AND NEW.status = 'retired' THEN
            NEW.retired_at = COALESCE(NEW.retired_at, now());
            INSERT INTO blade_serial_events
                (serial, event_type, actor, event_at, detail)
            VALUES (NEW.serial, 'retired', COALESCE(NEW.retired_by, NEW.registered_by),
                    NEW.retired_at, '桨叶退役');
        END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO blade_serial_events
            (serial, event_type, actor, event_at, detail)
        VALUES (NEW.serial, 'registered', NEW.registered_by,
                NEW.registered_at, '桨叶出厂号登记在册');
    END IF;
    RETURN NEW;
END;
$guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blade_serials_guard ON blade_serials;
CREATE TRIGGER trg_blade_serials_guard
    BEFORE INSERT OR UPDATE ON blade_serials
    FOR EACH ROW EXECUTE FUNCTION blade_serials_guard();
"""
