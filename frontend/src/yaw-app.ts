import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

type LogRow = {
  id: number;
  turbine_code: string;
  blade_serial: string | null;
  yaw_err_deg: number;
  status: string;
  verdict: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  processed_at: string | null;
};

type Blade = {
  serial: string;
  status: string;
  registered_by: string;
  registered_at: string;
  retired_by: string | null;
  retired_at: string | null;
  bind_count: number;
  example_log_id: number | null;
  example_turbine: string | null;
};

type BladeHistoryEntry = {
  id: number;
  serial: string;
  action: string;
  log_id: number | null;
  turbine_code: string | null;
  actor: string;
  at: string;
  detail: string | null;
};

type Session = {
  token: string;
  username: string;
  role: string;
};

type Tab = "submit" | "roster";

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
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.75rem;
      color: #38bdf8;
    }
    .sub {
      color: #94a3b8;
      margin-bottom: 1rem;
    }
    nav.topbar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      border-bottom: 1px solid #334155;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      flex-wrap: wrap;
    }
    nav.topbar .brand {
      font-weight: 700;
      color: #e2e8f0;
      margin-right: 0.75rem;
    }
    nav.topbar button.tab {
      background: transparent;
      border: 1px solid #475569;
      color: #cbd5e1;
      border-radius: 999px;
      padding: 0.35rem 1rem;
      font-weight: 500;
    }
    nav.topbar button.tab.active {
      background: #0284c7;
      border-color: #0284c7;
      color: #fff;
      font-weight: 600;
    }
    nav.topbar .spacer {
      flex: 1;
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
    select:invalid {
      color: #94a3b8;
    }
    .range-row {
      display: flex;
      gap: 0.5rem;
    }
    .range-row > div {
      flex: 1;
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
      padding: 0.25rem 0.6rem;
      font-size: 0.8rem;
    }
    button.link {
      background: transparent;
      color: #7dd3fc;
      padding: 0.15rem 0.4rem;
      font-size: 0.82rem;
      text-decoration: underline;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
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
    .active {
      background: #14532d;
      color: #86efac;
    }
    .retired {
      background: #475569;
      color: #cbd5e1;
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
    .roster-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    @media (max-width: 820px) {
      .roster-grid {
        grid-template-columns: 1fr;
      }
    }
    .muted {
      color: #94a3b8;
      font-size: 0.85rem;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }
    .modal {
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 8px;
      padding: 1.25rem;
      width: min(680px, 92vw);
      max-height: 80vh;
      overflow: auto;
    }
  `;

  @state() private session: Session | null = null;
  @state() private tab: Tab = "submit";
  @state() private logs: LogRow[] = [];
  @state() private activeBlades: Blade[] = [];
  @state() private retiredBlades: Blade[] = [];
  @state() private historySerial = "";
  @state() private history: BladeHistoryEntry[] = [];
  @state() private loginUser = "technician";
  @state() private loginPass = "tech123456";
  @state() private turbineCode = "";
  @state() private bladeSerial = "";
  @state() private yawErr = "";
  @state() private regPrefix = "BLD-";
  @state() private regStart = "2001";
  @state() private regEnd = "2010";
  @state() private regWidth = "4";
  @state() private error = "";
  @state() private notice = "";
  @state() private loading = false;

  connectedCallback() {
    super.connectedCallback();
    const raw = localStorage.getItem("yaw_session");
    if (raw) {
      try {
        this.session = JSON.parse(raw) as Session;
        void this.refreshAll();
        this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
      } catch {
        localStorage.removeItem("yaw_session");
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
  }

  private _pollTimer?: number;

  private authHeaders(): HeadersInit {
    return this.session
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
  }

  // 轮询只在后台静默刷新；名册维护后用 force=true 拿取最新数据
  private async refreshAll(force = false) {
    if (!this.session) return;
    await Promise.all([this.refreshLogs(), this.refreshBlades(force)]);
  }

  private async refreshLogs() {
    if (!this.session) return;
    try {
      const res = await fetch("/api/logs", { headers: this.authHeaders() });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (!res.ok) return;
      this.logs = (await res.json()) as LogRow[];
    } catch {
      /* ignore transient network errors */
    }
  }

  private async refreshBlades(force = false) {
    if (!this.session) return;
    try {
      const [actRes, retRes] = await Promise.all([
        fetch("/api/blades?status=active", { headers: this.authHeaders() }),
        fetch("/api/blades?status=retired", { headers: this.authHeaders() }),
      ]);
      if (actRes.status === 401 || retRes.status === 401) {
        this.logout();
        return;
      }
      if (actRes.ok && retRes.ok) {
        this.activeBlades = (await actRes.json()) as Blade[];
        this.retiredBlades = (await retRes.json()) as Blade[];
      }
      if (this.historySerial && force) {
        await this.loadHistory(this.historySerial);
      }
    } catch {
      /* ignore transient network errors */
    }
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
      await this.refreshAll(true);
      this._pollTimer = window.setInterval(() => void this.refreshAll(), 2000);
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
    this.activeBlades = [];
    this.retiredBlades = [];
    this.historySerial = "";
    this.tab = "submit";
    localStorage.removeItem("yaw_session");
  }

  private get isWriter() {
    return this.session?.role === "writer";
  }

  private switchTab(tab: Tab) {
    this.tab = tab;
    this.error = "";
    this.notice = "";
    void this.refreshBlades(true);
  }

  private async submitLog() {
    this.error = "";
    this.notice = "";
    if (!this.bladeSerial) {
      // 页面端先拦：空选整单退回；服务端会再次校验
      this.error = "请从在役桨叶出厂号中点选一个号，空选整单退回";
      return;
    }
    this.loading = true;
    try {
      const res = await fetch("/api/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          turbine_code: this.turbineCode,
          blade_serial: this.bladeSerial,
          yaw_err_deg: Number(this.yawErr),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "提交失败，单据退回";
        // 可能号刚被退役：刷新名册让下拉同步
        await this.refreshBlades(true);
        if (!this.activeBlades.some((b) => b.serial === this.bladeSerial)) {
          this.bladeSerial = "";
        }
        return;
      }
      this.notice = `报送已收下，单据 #${data.id} 绑定出厂号 ${data.blade_serial}`;
      this.turbineCode = "";
      this.bladeSerial = "";
      this.yawErr = "";
      await this.refreshAll(true);
    } catch {
      this.error = "提交时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async registerRange() {
    this.error = "";
    this.notice = "";
    this.loading = true;
    try {
      const res = await fetch("/api/blades/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          prefix: this.regPrefix,
          start: Number(this.regStart),
          end: Number(this.regEnd),
          width: Number(this.regWidth),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "登记失败";
        return;
      }
      this.notice = data.detail || "号段已登记";
      await this.refreshBlades(true);
    } catch {
      this.error = "登记时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async retireBlade(serial: string) {
    this.error = "";
    this.notice = "";
    if (
      !window.confirm(
        `确认退役出厂号 ${serial}？\n退役后该号不能再绑定新单据，已报送旧单仍保留原绑定且不可修改。`
      )
    ) {
      return;
    }
    this.loading = true;
    try {
      const res = await fetch(`/api/blades/${encodeURIComponent(serial)}/retire`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        this.error = data.detail || "退役失败";
        return;
      }
      this.notice = data.detail || "已退役";
      if (this.bladeSerial === serial) this.bladeSerial = "";
      await this.refreshBlades(true);
    } catch {
      this.error = "退役时网络异常";
    } finally {
      this.loading = false;
    }
  }

  private async loadHistory(serial: string) {
    try {
      const res = await fetch(
        `/api/blades/${encodeURIComponent(serial)}/history`,
        { headers: this.authHeaders() }
      );
      if (!res.ok) return;
      this.history = (await res.json()) as BladeHistoryEntry[];
    } catch {
      /* ignore */
    }
  }

  private async openHistory(serial: string) {
    this.historySerial = serial;
    this.history = [];
    await this.loadHistory(serial);
  }

  private closeHistory() {
    this.historySerial = "";
    this.history = [];
  }

  private verdictClass(row: LogRow) {
    if (row.status === "pending") return "pending";
    if (row.verdict === "合格") return "ok";
    if (row.verdict === "偏航超差") return "bad";
    return "";
  }

  private fmtTime(v: string | null) {
    if (!v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? v
      : d.toLocaleString("zh-CN", { hour12: false });
  }

  private actionLabel(a: string) {
    if (a === "register") return "登记";
    if (a === "bind") return "绑定单据";
    if (a === "retire") return "退役";
    return a;
  }

  private actionClass(a: string) {
    if (a === "register") return "ok";
    if (a === "retire") return "retired";
    return "pending";
  }

  private renderLogin() {
    return html`
      <h1>风机偏航对中台</h1>
      <p class="sub">现场技师提交偏航误差并绑定在役桨叶出厂号；观察者只读名册与单据。</p>
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

  private renderTopbar() {
    return html`
      <nav class="topbar">
        <span class="brand">风机偏航对中台</span>
        <button
          class="tab ${this.tab === "submit" ? "active" : ""}"
          @click=${() => this.switchTab("submit")}
        >
          对中报送
        </button>
        <button
          class="tab ${this.tab === "roster" ? "active" : ""}"
          @click=${() => this.switchTab("roster")}
        >
          桨叶出厂号名册
        </button>
        <span class="spacer"></span>
        <span class="muted">
          ${this.session!.username}（${this.isWriter ? "现场技师" : "观察者"}）
        </span>
        <button class="secondary" @click=${this.logout}>退出</button>
      </nav>
    `;
  }

  private renderSubmitTab() {
    return html`
      ${this.isWriter
        ? html`
            <section>
              <h2>报送偏航记录</h2>
              <p class="muted" style="margin-top:0;">
                报送前须点选一个<b>在役</b>出厂号；空选或选退役号整单退回。绑定后出厂号随单冻结，退役不影响旧单。
              </p>
              <label>机组编号</label>
              <input
                placeholder="例如 W12"
                .value=${this.turbineCode}
                @input=${(e: Event) =>
                  (this.turbineCode = (e.target as HTMLInputElement).value)}
              />
              <label for="blade-select">桨叶出厂号（仅列在役号，必选）</label>
              <select
                id="blade-select"
                required
                .value=${this.bladeSerial}
                @change=${(e: Event) =>
                  (this.bladeSerial = (e.target as HTMLSelectElement).value)}
              >
                <option value="" disabled ?selected=${!this.bladeSerial}>
                  — 请选择在役桨叶出厂号 —
                </option>
                ${this.activeBlades.map(
                  (b) => html`
                    <option value=${b.serial} ?selected=${b.serial === this.bladeSerial}>
                      ${b.serial}${b.bind_count > 0
                        ? `（已绑 ${b.bind_count} 单）`
                        : "（未绑定）"}
                    </option>
                  `
                )}
              </select>
              ${this.activeBlades.length === 0
                ? html`<p class="err">名册中暂无在役号，请先到「桨叶出厂号名册」登记。</p>`
                : null}
              <label>偏航误差（度，可正可负）</label>
              <input
                type="number"
                step="0.1"
                .value=${this.yawErr}
                @input=${(e: Event) =>
                  (this.yawErr = (e.target as HTMLInputElement).value)}
              />
              <button
                ?disabled=${this.loading ||
                this.activeBlades.length === 0 ||
                !this.bladeSerial}
                @click=${this.submitLog}
              >
                报送（进入待认领队列）
              </button>
              ${this.error ? html`<p class="err">${this.error}</p>` : null}
              ${this.notice ? html`<p class="ok-msg">${this.notice}</p>` : null}
            </section>
          `
        : html`
            <section>
              <p class="muted" style="margin:0;">观察者账号只读，不能报送；桨叶名册维护亦仅现场技师可用。</p>
            </section>
          `}

      <section>
        <div class="row-actions">
          <h2 style="margin:0;flex:1;">对中记录</h2>
          <button class="secondary" ?disabled=${this.loading} @click=${() => this.refreshLogs()}>
            刷新
          </button>
        </div>
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
                      ? html`<button
                          class="link"
                          title="查看该出厂号履历"
                          @click=${() => this.openHistory(row.blade_serial!)}
                        >
                          ${row.blade_serial}
                        </button>`
                      : html`<span class="muted">未绑定</span>`}
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

  private renderBladeTable(blades: Blade[], kind: "active" | "retired") {
    return html`
      <table>
        <thead>
          <tr>
            <th>出厂号</th>
            <th>绑定示例</th>
            <th>${kind === "active" ? "登记" : "退役"}时间 / 操作人</th>
            <th>履历</th>
            ${kind === "active" && this.isWriter ? html`<th>操作</th>` : null}
          </tr>
        </thead>
        <tbody>
          ${blades.length === 0
            ? html`<tr><td colspan="5" class="muted">暂无${kind === "active" ? "在役" : "退役"}出厂号</td></tr>`
            : blades.map(
                (b) => html`
                  <tr>
                    <td>
                      <span class="tag ${kind}">${b.serial}</span>
                    </td>
                    <td>
                      ${b.example_log_id != null
                        ? html`单据 #${b.example_log_id} · 机组 ${b.example_turbine ?? "—"}
                            <span class="muted">（共 ${b.bind_count} 单）</span>`
                        : html`<span class="muted">尚未绑定单据</span>`}
                    </td>
                    <td>
                      ${kind === "active"
                        ? html`${this.fmtTime(b.registered_at)}<br /><span class="muted">${b.registered_by}</span>`
                        : html`${this.fmtTime(b.retired_at)}<br /><span class="muted">${b.retired_by ?? "—"}</span>`}
                    </td>
                    <td>
                      <button class="link" @click=${() => this.openHistory(b.serial)}>
                        查看履历
                      </button>
                    </td>
                    ${kind === "active" && this.isWriter
                      ? html`<td>
                          <button
                            class="danger"
                            ?disabled=${this.loading}
                            @click=${() => this.retireBlade(b.serial)}
                          >
                            退役
                          </button>
                        </td>`
                      : null}
                  </tr>
                `
              )}
        </tbody>
      </table>
    `;
  }

  private renderRosterTab() {
    return html`
      ${this.isWriter
        ? html`
            <section>
              <h2>登记号段（现场技师）</h2>
              <p class="muted" style="margin-top:0;">
                按前缀 + 起止序号批量登记在役号，如前缀 BLD-、起 2001、止 2010、位宽 4 生成
                BLD-2001…BLD-2010。已在册号（含退役号）不可重复登记。
              </p>
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
                  <label>起始序号</label>
                  <input
                    type="number"
                    .value=${this.regStart}
                    @input=${(e: Event) =>
                      (this.regStart = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>截止序号</label>
                  <input
                    type="number"
                    .value=${this.regEnd}
                    @input=${(e: Event) =>
                      (this.regEnd = (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label>序号位宽</label>
                  <input
                    type="number"
                    min="0"
                    max="12"
                    .value=${this.regWidth}
                    @input=${(e: Event) =>
                      (this.regWidth = (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
              <button ?disabled=${this.loading} @click=${this.registerRange}>
                登记号段为在役
              </button>
              ${this.error ? html`<p class="err">${this.error}</p>` : null}
              ${this.notice ? html`<p class="ok-msg">${this.notice}</p>` : null}
            </section>
          `
        : html`
            <section>
              <p class="muted" style="margin:0;">
                观察者只读：可查名册与每号履历，不能登记号段、退役或报送。
              </p>
            </section>
          `}

      <div class="roster-grid">
        <section>
          <h2>在役出厂号（${this.activeBlades.length}）</h2>
          ${this.renderBladeTable(this.activeBlades, "active")}
        </section>
        <section>
          <h2>退役出厂号（${this.retiredBlades.length}）</h2>
          ${this.renderBladeTable(this.retiredBlades, "retired")}
        </section>
      </div>

      ${this.historySerial
        ? html`
            <div class="modal-backdrop" @click=${() => this.closeHistory()}>
              <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
                <div class="row-actions">
                  <h2 style="margin:0;flex:1;">出厂号履历 · ${this.historySerial}</h2>
                  <button class="secondary" @click=${() => this.closeHistory()}>关闭</button>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>动作</th>
                      <th>单据 / 机组</th>
                      <th>操作人</th>
                      <th>时间</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.history.map(
                      (h) => html`
                        <tr>
                          <td><span class="tag ${this.actionClass(h.action)}">${this.actionLabel(h.action)}</span></td>
                          <td>
                            ${h.log_id != null
                              ? html`#${h.log_id} · ${h.turbine_code ?? "—"}`
                              : "—"}
                          </td>
                          <td>${h.actor}</td>
                          <td>${this.fmtTime(h.at)}</td>
                          <td>${h.detail ?? "—"}</td>
                        </tr>
                      `
                    )}
                    ${this.history.length === 0
                      ? html`<tr><td colspan="5" class="muted">无履历记录</td></tr>`
                      : null}
                  </tbody>
                </table>
              </div>
            </div>
          `
        : null}
    `;
  }

  render() {
    if (!this.session) {
      return this.renderLogin();
    }

    return html`
      ${this.renderTopbar()}
      ${this.tab === "submit" ? this.renderSubmitTab() : this.renderRosterTab()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "yaw-align-app": YawAlignApp;
  }
}
