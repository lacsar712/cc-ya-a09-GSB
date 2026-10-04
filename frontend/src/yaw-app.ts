import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
  yaw_err_deg: number;
  status: string;
  verdict: string | null;
  reason: string | null;
  blade_serial: string | null;
  created_by: string;
  created_at: string;
  processed_at: string | null;
};

type BoundLog = {
  id: number;
  turbine_code: string;
  status: string;
  created_at: string;
};

type BladeRow = {
  serial: string;
  status: "in_service" | "retired";
  registered_by: string;
  registered_at: string;
  retired_by: string | null;
  retired_at: string | null;
  bound_logs: BoundLog[];
};

type Roster = {
  in_service: BladeRow[];
  retired: BladeRow[];
};

type BladeEvent = {
  id: number;
  serial: string;
  event_type: "registered" | "retired" | "bound" | "unbound";
  actor: string;
  event_at: string;
  log_id: number | null;
  detail: string | null;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type Page = "logs" | "blades";

const EVENT_LABEL: Record<string, string> = {
  registered: "登记",
  retired: "退役",
  bound: "绑定",
  unbound: "解绑",
};

function fmtTime(raw: string | null): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? raw
    : d.toLocaleString("zh-CN", { hour12: false });
}

@customElement("yaw-align-app")
export class YawAlignApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      box-sizing: border-box;
      padding: 1.5rem;
      max-width: 1040px;
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }
    h1 {
      margin: 0;
      font-size: 1.5rem;
      color: #38bdf8;
    }
    nav {
      display: flex;
      gap: 0.5rem;
    }
    nav button {
      background: #334155;
    }
    nav button.active {
      background: #0284c7;
    }
    .sub {
      color: #94a3b8;
      margin-bottom: 1.25rem;
    }
    section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      border: 1px solid #334155;
    }
    h2 {
      margin-top: 0;
      font-size: 1.1rem;
    }
    h3 {
      font-size: 0.98rem;
      color: #cbd5e1;
      margin: 1rem 0 0.5rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-bottom: 0.25rem;
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 0.5rem 0.65rem;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #0f172a;
      color: #f1f5f9;
      margin-bottom: 0.75rem;
    }
    .range-row {
      display: flex;
      gap: 0.5rem;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .range-row div {
      flex: 1 1 6rem;
    }
    .range-row input {
      margin-bottom: 0;
    }
    button {
      cursor: pointer;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      border: none;
      background: #0284c7;
      color: #fff;
      font-weight: 600;
    }
    button.secondary {
      background: #475569;
    }
    button.danger {
      background: #b91c1c;
      padding: 0.3rem 0.7rem;
      font-size: 0.8rem;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }
    th,
    td {
      text-align: left;
      padding: 0.5rem 0.4rem;
      border-bottom: 1px solid #334155;
      vertical-align: top;
    }
    th {
      color: #94a3b8;
      font-weight: 600;
      white-space: nowrap;
    }
    .tag {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.8rem;
    }
    .ok {
      background: #14532d;
      color: #86efac;
    }
    .bad {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .pending {
      background: #713f12;
      color: #fde68a;
    }
    .in {
      background: #14532d;
      color: #86efac;
    }
    .ret {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .ev {
      font-size: 0.78rem;
      padding: 0.1rem 0.35rem;
    }
    .ev-registered {
      background: #1e3a5f;
      color: #93c5fd;
    }
    .ev-retired {
      background: #7f1d1d;
      color: #fca5a5;
    }
    .ev-bound {
      background: #14532d;
      color: #86efac;
    }
    .ev-unbound {
      background: #44403c;
      color: #d6d3d1;
    }
    .err {
      color: #f87171;
      margin-top: 0.5rem;
    }
    .ok-msg {
      color: #86efac;
      margin-top: 0.5rem;
    }
    .row-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .muted {
      color: #94a3b8;
      font-size: 0.82rem;
    }
    .binding {
      font-size: 0.78rem;
      color: #cbd5e1;
    }
    .binding div {
      margin-top: 0.15rem;
    }
  `;

  @state() private session: Session | null = null;
  @state() private page: Page = "logs";
  @state() private logs: LogRow[] = [];
  @state() private roster: Roster = { in_service: [], retired: [] };
  @state() private events: BladeEvent[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";
  @state() private turbineCode = "";
  @state() private yawErr = "";
  @state() private bladeSerial = "";
  @state() private regSingle = "";
  @state() private regPrefix = "BLADE-";
  @state() private regStart = "";
  @state() private regEnd = "";
  @state() private regWidth = "3";
  @state() private historyFilter = "";
  @state() private error = "";
  @state() private notice = "";
  @state() private loading = false;

  private _pollTimer?: number;

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.refreshAll();
        this._pollTimer = window.setInterval(() => void this.pollTick(), 2000);
      } catch {
        localStorage.removeItem("yaw_session");
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  private async pollTick() {
    await this.refreshLogs();
    // 名册也定期刷新，以便其他人的登记/退役及时可见
    await this.refreshRoster();
  }

  private authHeaders(): HeadersInit {
    return this.session
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
  }

  private async api(path: string, init?: RequestInit) {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...this.authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  private async refreshLogs() {
    if (!this.session) return;
    const { res, data } = await this.api("/api/logs");
    if (res.status === 401) {
      this.logout();
      return;
    }
    if (res.ok) this.logs = data as LogRow[];
  }

  private async refreshRoster() {
    if (!this.session) return;
    const { res, data } = await this.api("/api/blades");
    if (res.status === 401) {
      this.logout();
      return;
    }
    if (res.ok) this.roster = data as Roster;
  }

  private async refreshHistory() {
    if (!this.session) return;
    const q = this.historyFilter.trim()
      ? `?serial=${encodeURIComponent(this.historyFilter.trim().toUpperCase())}`
      : "";
    const { res, data } = await this.api(`/api/blades/history${q}`);
    if (res.ok) this.events = data as BladeEvent[];
  }

  private async refreshAll() {
    await Promise.all([
      this.refreshLogs(),
      this.refreshRoster(),
      this.refreshHistory(),
    ]);
  }

  private async login() {
    this.error = "";
    this.loading = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.loginUser,
          password: this.loginPass,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "登录失败";
        return;
      }
      this.session = {
        token: data.access_token,
        username: data.username,
        role: data.role,
      };
      localStorage.setItem("yaw_session", JSON.stringify(this.session));
      await this.refreshAll();
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = window.setInterval(() => void this.pollTick(), 2000);
    } catch {
      this.error = "无法连接接口";
    } finally {
      this.loading = false;
    }
  }

  private logout() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this.session = null;
    this.logs = [];
    this.roster = { in_service: [], retired: [] };
    this.events = [];
    localStorage.removeItem("yaw_session");
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private go(page: Page) {
    this.page = page;
    this.error = "";
    this.notice = "";
    if (page === "blades") void this.refreshRoster().then(() => this.refreshHistory());
  }

  private async submitLog() {
    this.error = "";
    this.notice = "";
    if (!this.bladeSerial) {
      this.error = "须点选在役桨叶出厂号，空选整单退回";
      return;
    }
    this.loading = true;
    try {
      const { res, data } = await this.api("/api/logs", {
        method: "POST",
        body: JSON.stringify({
          turbine_code: this.turbineCode,
          yaw_err_deg: Number(this.yawErr),
          blade_serial: this.bladeSerial,
        }),
      });
      if (!res.ok) {
        this.error = data.detail || "提交失败，报送整单退回";
        return;
      }
      this.turbineCode = "";
      this.yawErr = "";
      this.bladeSerial = "";
      this.notice = "报送已收下，桨叶出厂号已随单冻结";
      await this.refreshAll();
    } catch {
      this.error = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async registerBlades() {
    this.error = "";
    this.notice = "";
    const single = this.regSingle.trim();
    const hasRange = this.regStart.trim() || this.regEnd.trim();
    if (!single && !hasRange) {
      this.error = "请填写单号，或填写号段起止";
      return;
    }
    const payload: Record<string, unknown> = {};
    if (single) payload.serial = single;
    if (hasRange) {
      payload.prefix = this.regPrefix;
      payload.start = Number(this.regStart);
      payload.end = Number(this.regEnd);
      payload.width = Number(this.regWidth);
    }
    this.loading = true;
    try {
      const { res, data } = await this.api("/api/blades/register", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.error = data.detail || "登记失败";
        return;
      }
      this.regSingle = "";
      this.regStart = "";
      this.regEnd = "";
      this.notice = `已登记 ${data.count} 个在役出厂号，履历已同步落账`;
      await this.refreshRoster();
      await this.refreshHistory();
    } catch {
      this.error = "登记时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async retireBlade(serial: string) {
    this.error = "";
    this.notice = "";
    if (!window.confirm(`确认将出厂号 ${serial} 退役？退役后不能恢复，也不能再用于新报送；已绑定的旧单保留原号。`)) {
      return;
    }
    this.loading = true;
    try {
      const { res, data } = await this.api(
        `/api/blades/${encodeURIComponent(serial)}/retire`,
        { method: "POST" }
      );
      if (!res.ok) {
        this.error = data.detail || "退役失败";
        return;
      }
      this.notice = `${serial} 已退役，履历已同步落账；旧单绑定不受影响`;
      if (this.bladeSerial === serial) this.bladeSerial = "";
      await this.refreshRoster();
      await this.refreshHistory();
    } catch {
      this.error = "退役时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private verdictClass(row: LogRow) {
    if (row.status === "pending") return "pending";
    if (row.verdict === "合格") return "ok";
    if (row.verdict === "偏航超差") return "bad";
    return "";
  }

  private bladeTable(rows: BladeRow[], retired: boolean) {
    return html`
      <table>
        <thead>
          <tr>
            <th>出厂号</th>
            <th>状态</th>
            <th>${retired ? "退役人/时间" : "登记人/时间"}</th>
            <th>绑定示例（报送单）</th>
            ${this.isWriter && !retired ? html`<th>操作</th>` : null}
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? html`<tr><td colspan="5" class="muted">暂无记录</td></tr>`
            : rows.map(
                (b) => html`
                  <tr>
                    <td><strong>${b.serial}</strong></td>
                    <td>
                      <span class="tag ${retired ? "ret" : "in"}">
                        ${retired ? "退役" : "在役"}
                      </span>
                    </td>
                    <td class="muted">
                      ${retired
                        ? html`${b.retired_by ?? "—"}<br />${fmtTime(b.retired_at)}`
                        : html`${b.registered_by}<br />${fmtTime(b.registered_at)}`}
                    </td>
                    <td class="binding">
                      ${b.bound_logs.length === 0
                        ? html`<span class="muted">未绑定</span>`
                        : b.bound_logs.slice(0, 3).map(
                            (l) => html`
                              <div>
                                单 #${l.id} · 机组 ${l.turbine_code} ·
                                ${l.status === "pending" ? "待处理" : "已完成"}
                                · ${fmtTime(l.created_at)}
                              </div>
                            `
                          )}
                      ${b.bound_logs.length > 3
                        ? html`<div class="muted">等 ${b.bound_logs.length} 条</div>`
                        : null}
                    </td>
                    ${this.isWriter && !retired
                      ? html`
                          <td>
                            <button
                              class="danger"
                              ?disabled=${this.loading}
                              @click=${() => this.retireBlade(b.serial)}
                            >
                              退役
                            </button>
                          </td>
                        `
                      : null}
                  </tr>
                `
              )}
        </tbody>
      </table>
    `;
  }

  private renderLogin() {
    return html`
      <h1>风机偏航对中台</h1>
      <p class="sub">现场技师提交偏航误差须绑定在役桨叶出厂号；观察者可只读查阅名册与记录。</p>
      <section>
        <label>用户名</label>
        <input
          .value=${this.loginUser}
          @input=${(e: Event) =>
            (this.loginUser = (e.target as HTMLInputElement).value)}
        />
        <label>密码</label>
        <input
          type="password"
          .value=${this.loginPass}
          @input=${(e: Event) =>
            (this.loginPass = (e.target as HTMLInputElement).value)}
        />
        <button ?disabled=${this.loading} @click=${this.login}>登录</button>
        ${this.error ? html`<p class="err">${this.error}</p>` : null}
      </section>
    `;
  }

  private renderLogsPage() {
    return html`
      ${this.isWriter
        ? html`
            <section>
              <h2>提交偏航报送</h2>
              <p class="muted" style="margin-top:0">
                桨叶出厂号只能从当前<strong>在役</strong>名册中点选；空选或选到已退役号，整单退回。
                报送收下后出厂号随单冻结，退役不影响旧单。
              </p>
              <label>机组编号</label>
              <input
                placeholder="例如 W12"
                .value=${this.turbineCode}
                @input=${(e: Event) =>
                  (this.turbineCode = (e.target as HTMLInputElement).value)}
              />
              <label>偏航误差（度，可正可负）</label>
              <input
                type="number"
                step="0.1"
                .value=${this.yawErr}
                @input=${(e: Event) =>
                  (this.yawErr = (e.target as HTMLInputElement).value)}
              />
              <label>桨叶出厂号（必选，仅列在役）</label>
              <select
                .value=${this.bladeSerial}
                @change=${(e: Event) =>
                  (this.bladeSerial = (e.target as HTMLSelectElement).value)}
              >
                <option value="">— 请选择在役桨叶出厂号 —</option>
                ${this.roster.in_service.map(
                  (b) => html`<option value=${b.serial}>${b.serial}</option>`
                )}
              </select>
              ${this.roster.in_service.length === 0
                ? html`<p class="err">名册中暂无在役出厂号，请先到「桨叶名册」登记。</p>`
                : null}
              <button
                ?disabled=${this.loading || this.roster.in_service.length === 0}
                @click=${this.submitLog}
              >
                提交报送（进入待认领队列）
              </button>
              ${this.error ? html`<p class="err">${this.error}</p>` : null}
              ${this.notice ? html`<p class="ok-msg">${this.notice}</p>` : null}
            </section>
          `
        : html`
            <section class="muted">
              观察者账号只读：可查看报送记录与桨叶名册，不能提交报送或维护名册。
            </section>
          `}

      <section>
        <h2>对中报送记录</h2>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>机组</th>
              <th>桨叶出厂号</th>
              <th>误差°</th>
              <th>状态</th>
              <th>结论</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            ${this.logs.map(
              (row) => html`
                <tr>
                  <td>${row.id}</td>
                  <td>${row.turbine_code}</td>
                  <td>
                    ${row.blade_serial
                      ? html`<strong>${row.blade_serial}</strong>`
                      : html`<span class="muted">—</span>`}
                  </td>
                  <td>${row.yaw_err_deg}</td>
                  <td>
                    <span class="tag ${row.status === "pending" ? "pending" : "ok"}">
                      ${row.status === "pending" ? "待处理" : "已完成"}
                    </span>
                  </td>
                  <td>
                    ${row.verdict
                      ? html`<span class="tag ${this.verdictClass(row)}">${row.verdict}</span>`
                      : "—"}
                  </td>
                  <td>${row.reason ?? "—"}</td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </section>
    `;
  }

  private renderBladesPage() {
    return html`
      <section>
        <h2>桨叶出厂号名册</h2>
        <p class="muted" style="margin-top:0">
          在役号可用于新报送并随单冻结；退役号不能再绑定新单，已绑旧单仍保留原号。
        </p>

        ${this.isWriter
          ? html`
              <h3>单号登记</h3>
              <div class="range-row">
                <div>
                  <label>出厂号</label>
                  <input
                    placeholder="例如 BLADE-010"
                    .value=${this.regSingle}
                    @input=${(e: Event) =>
                      (this.regSingle = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div style="flex:0 0 auto">
                  <button ?disabled=${this.loading} @click=${this.registerBlades}>
                    登记在役
                  </button>
                </div>
              </div>

              <h3>号段登记</h3>
              <div class="range-row">
                <div>
                  <label>前缀</label>
                  <input
                    .value=${this.regPrefix}
                    @input=${(e: Event) =>
                      (this.regPrefix = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>起始</label>
                  <input
                    type="number"
                    .value=${this.regStart}
                    @input=${(e: Event) =>
                      (this.regStart = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>终止</label>
                  <input
                    type="number"
                    .value=${this.regEnd}
                    @input=${(e: Event) =>
                      (this.regEnd = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>补零位宽</label>
                  <input
                    type="number"
                    min="1"
                    max="8"
                    .value=${this.regWidth}
                    @input=${(e: Event) =>
                      (this.regWidth = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div style="flex:0 0 auto">
                  <button ?disabled=${this.loading} @click=${this.registerBlades}>
                    登记号段
                  </button>
                </div>
              </div>
              <p class="muted">
                示例：前缀 BLADE-、起始 10、终止 12、位宽 3 → BLADE-010、BLADE-011、BLADE-012。
              </p>
              ${this.error ? html`<p class="err">${this.error}</p>` : null}
              ${this.notice ? html`<p class="ok-msg">${this.notice}</p>` : null}
            `
          : html`<p class="muted">观察者只读：名册维护（登记 / 退役）仅现场技师可用。</p>`}
      </section>

      <section>
        <h3>在役（${this.roster.in_service.length}）</h3>
        ${this.bladeTable(this.roster.in_service, false)}
      </section>

      <section>
        <h3>退役（${this.roster.retired.length}）</h3>
        ${this.bladeTable(this.roster.retired, true)}
      </section>

      <section>
        <h3>名册变更与绑定履历</h3>
        <div class="range-row">
          <div>
            <label>按出厂号过滤（留空显示全部）</label>
            <input
              placeholder="例如 BLADE-006"
              .value=${this.historyFilter}
              @input=${(e: Event) =>
                (this.historyFilter = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div style="flex:0 0 auto">
            <button class="secondary" @click=${this.refreshHistory}>查询履历</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>出厂号</th>
              <th>事件</th>
              <th>操作人</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            ${this.events.map(
              (ev) => html`
                <tr>
                  <td class="muted">${fmtTime(ev.event_at)}</td>
                  <td><strong>${ev.serial}</strong></td>
                  <td>
                    <span class="tag ev ev-${ev.event_type}">
                      ${EVENT_LABEL[ev.event_type] ?? ev.event_type}
                    </span>
                  </td>
                  <td>${ev.actor}</td>
                  <td>${ev.detail ?? "—"}</td>
                </tr>
              `
            )}
            ${this.events.length === 0
              ? html`<tr><td colspan="5" class="muted">暂无履历</td></tr>`
              : null}
          </tbody>
        </table>
      </section>
    `;
  }

  render() {
    if (!this.session) {
      return this.renderLogin();
    }

    return html`
      <div class="topbar">
        <h1>风机偏航对中台</h1>
        <nav>
          <button
            class=${this.page === "logs" ? "active" : ""}
            @click=${() => this.go("logs")}
          >
            报送记录
          </button>
          <button
            class=${this.page === "blades" ? "active" : ""}
            @click=${() => this.go("blades")}
          >
            桨叶名册
          </button>
          <button class="secondary" @click=${this.logout}>
            退出（${this.session.username}）
          </button>
        </nav>
      </div>
      <p class="sub">当前账号：${this.session.username}（${this.isWriter ? "现场技师 · 可维护/可报送" : "观察者 · 只读"}）</p>
      ${this.page === "logs" ? this.renderLogsPage() : this.renderBladesPage()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
