const state = {
  data: null,
  expanded: new Set(),
  initializedRootIds: new Set(),
  hideCompleted: false,
  isLoading: false,
};

const statusLabels = {
  working: "작업 중",
  observed: "실행 관측",
  waiting: "대기",
  completed: "완료",
  stale: "오래됨",
  unknown: "확인 중",
};

const elements = {
  metrics: document.querySelector("#metrics"),
  sessionList: document.querySelector("#session-list"),
  runtimeList: document.querySelector("#runtime-list"),
  refreshButton: document.querySelector("#refresh-button"),
  refreshState: document.querySelector("#refresh-state"),
  sourceLabel: document.querySelector("#source-label"),
  hideCompleted: document.querySelector("#hide-completed"),
};

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function shortPath(value) {
  if (!value) {
    return "작업 디렉터리 정보 없음";
  }
  return value.replace(/^\/Users\/[^/]+/, "~");
}

function appendPathText(node, value) {
  const segments = shortPath(value).split("/");

  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      node.append(document.createTextNode("/"), document.createElement("wbr"));
    }
    if (segment) {
      node.append(element("span", "path-segment", segment));
    }
  }
}

function setPathText(node, value) {
  node.replaceChildren();
  appendPathText(node, value);
}

function appendTitleProse(node, value) {
  const protectedShortWords = value.replace(/(^|[\s()[\]{}])([가-힣]) (?=[가-힣])/g, "$1$2\u00a0");
  node.append(document.createTextNode(protectedShortWords));
}

function appendTitlePath(node, value) {
  const segments = value.split("/");
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      node.append(document.createTextNode("/"), document.createElement("wbr"));
    }
    if (segment) {
      node.append(element("span", "title-path-segment", segment));
    }
  }
}

function setSessionTitleText(node, value) {
  const text = String(value || "");
  const pathPattern = /(?:~\/|\/)[^\s]+/g;
  const content = document.createDocumentFragment();
  let cursor = 0;

  for (const match of text.matchAll(pathPattern)) {
    appendTitleProse(content, text.slice(cursor, match.index));
    appendTitlePath(content, match[0]);
    cursor = (match.index || 0) + match[0].length;
  }
  appendTitleProse(content, text.slice(cursor));
  node.replaceChildren(content);
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}…` : "알 수 없음";
}

function relativeTime(timestamp) {
  if (!timestamp) {
    return "시간 정보 없음";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "방금 전";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ko-KR").format(value || 0);
}

function statusChip(status) {
  const chip = element("span", `status-chip status-${status}`);
  chip.title = statusLabels[status] || "확인 중";
  chip.append(element("span", "status-dot"), document.createTextNode(statusLabels[status] || "확인 중"));
  return chip;
}

function metricCard(label, value, caption) {
  const card = element("article", "metric-card");
  card.append(element("p", "eyebrow", label));
  card.append(element("p", "metric-value", value));
  card.append(element("p", "metric-caption", caption));
  return card;
}

function renderMetrics(data) {
  const metrics = [
    ["MAIN SESSIONS", formatNumber(data.summary.roots), "표시 중인 메인 세션"],
    ["AGENT NODES", formatNumber(data.summary.agents), "트리에 포함된 에이전트"],
    ["LIVE PROCESSES", formatNumber(data.summary.liveProcesses), "실행 중인 Codex 프로세스"],
    ["ACTIVE SIGNALS", formatNumber(data.summary.workingAgents), "최근 활동 또는 실행 관측"],
  ];
  elements.metrics.replaceChildren(...metrics.map(([label, value, caption]) => metricCard(label, value, caption)));
}

function nodeIsHidden(node) {
  return state.hideCompleted && node.status === "completed";
}

function visibleChildren(node) {
  return node.children.filter((child) => !nodeIsHidden(child));
}

function createAgentNode(node, isRoot = false) {
  const wrapper = element("div", "agent-node");
  const row = element("div", "agent-row");
  const topline = element("div", "agent-topline");
  const nameWrap = element("div", "agent-name-wrap");
  const name = element("p", "agent-name", node.agentName);
  name.title = node.title;
  const role = element("span", "agent-role", `${isRoot ? "메인" : "서브"} · ${node.role}`);
  const identifier = element("span", "agent-id", shortId(node.id));
  identifier.title = node.id || "";
  nameWrap.append(name, role, document.createTextNode(" "), identifier);
  topline.append(nameWrap, statusChip(node.status));
  row.append(topline);

  const activity = element("p", "activity-text", node.activity?.text || "최근 활동 정보 없음");
  activity.title = node.activity?.text || "최근 활동 정보 없음";
  row.append(activity);

  const updatedAt = relativeTime(node.activity?.timestamp || node.updatedAt);
  const runtimePids = node.runtimePids.length ? ` · 같은 디렉터리 PID ${node.runtimePids.join(", ")}` : "";
  const metaText = `${updatedAt} · ${shortPath(node.cwd)}${runtimePids}`;
  const meta = element("p", "activity-text agent-meta");
  const cwd = element("span", "inline-path");
  setPathText(cwd, node.cwd);
  cwd.title = node.cwd || "";
  meta.title = metaText;
  meta.append(document.createTextNode(`${updatedAt} · `), cwd, document.createTextNode(runtimePids));
  row.append(meta);

  if (node.edgeStatus) {
    row.append(element("span", "edge-state", `하위 작업 상태: ${node.edgeStatus}`));
  }

  wrapper.append(row);
  const children = visibleChildren(node);
  if (children.length === 0) {
    return wrapper;
  }

  const expanded = state.expanded.has(node.id);
  const actions = element("div", "agent-actions");
  const toggle = element("button", "button button-quiet", expanded ? `하위 ${children.length}명 접기` : `하위 ${children.length}명 펼치기`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.addEventListener("click", () => {
    if (state.expanded.has(node.id)) {
      state.expanded.delete(node.id);
    } else {
      state.expanded.add(node.id);
    }
    renderSessions(state.data);
  });
  actions.append(toggle);
  wrapper.append(actions);

  if (expanded) {
    const childContainer = element("div", "agent-children");
    childContainer.append(...children.map((child) => createAgentNode(child)));
    wrapper.append(childContainer);
  }

  return wrapper;
}

function createSessionCard(session) {
  const card = element("article", "session-card");
  const header = element("header", "session-card-header");
  const titleWrap = element("div");
  const title = element("h3", "session-card-title");
  setSessionTitleText(title, session.title);
  title.title = session.title;
  const meta = element("p", "session-meta");
  const workspace = element("span", "session-path");
  setPathText(workspace, session.cwd);
  workspace.title = session.cwd || "";
  const update = element("span", "", `최근 갱신 ${relativeTime(session.updatedAt)}`);
  const identifier = element("code", "", shortId(session.id));
  identifier.title = session.id || "";
  meta.append(workspace, update, identifier);
  titleWrap.append(title, meta);
  header.append(titleWrap, statusChip(session.status));
  card.append(header);

  const tree = element("div", "session-tree");
  tree.append(createAgentNode(session, true));
  card.append(tree);
  return card;
}

function statePanel(kind, heading, message) {
  const panel = element("div", `${kind}-state`);
  panel.append(element("h3", "", heading), element("p", `${kind}-copy`, message));
  return panel;
}

function renderSessions(data) {
  const sessions = data.sessions.filter((session) => !nodeIsHidden(session));
  const content = sessions.length
    ? sessions.map((session) => createSessionCard(session))
    : [statePanel("empty", "표시할 현재 세션이 없습니다", "실행 중인 Codex와 최근 활동한 세션이 이곳에 나타납니다.")];

  if (data.warnings.length > 0) {
    const warnings = element("ul", "warning-list");
    warnings.append(...data.warnings.map((warning) => element("li", "", warning)));
    content.push(warnings);
  }

  elements.sessionList.replaceChildren(...content);
}

function renderRuntimes(data) {
  if (data.runtimes.length === 0) {
    elements.runtimeList.replaceChildren(
      statePanel("empty", "실행 중인 Codex가 없습니다", "새 Codex 세션을 시작하면 이 목록에 PID와 작업 디렉터리가 표시됩니다."),
    );
    return;
  }

  const rows = data.runtimes.map((runtime) => {
    const row = element("article", "runtime-row");
    const topline = element("div", "runtime-topline");
    topline.append(element("p", "runtime-pid", `PID ${runtime.pid}`), element("span", "source-label", runtime.state));
    const cwd = element("p", "runtime-cwd");
    setPathText(cwd, runtime.cwd);
    cwd.title = runtime.cwd || "작업 디렉터리 정보를 찾지 못했습니다";
    const meta = element("p", "runtime-meta");
    meta.append(
      element("span", "", `경과 ${runtime.elapsed}`),
      element("span", "", `CPU ${runtime.cpuPercent.toFixed(1)}%`),
      element("span", "", `메모리 ${runtime.memoryPercent.toFixed(1)}%`),
    );
    row.append(topline, cwd, meta);
    return row;
  });
  elements.runtimeList.replaceChildren(...rows);
}

function render(data) {
  renderMetrics(data);
  renderSessions(data);
  renderRuntimes(data);
  elements.sourceLabel.textContent = data.source.database ? `${data.source.database} · 읽기 전용` : "읽기 전용";
}

function setRefreshState(text) {
  elements.refreshState.textContent = text;
}

async function load({ background = false } = {}) {
  if (state.isLoading) {
    return;
  }

  state.isLoading = true;
  elements.refreshButton.disabled = true;
  if (!background) {
    setRefreshState("로컬 상태 읽는 중");
  }

  try {
    const response = await fetch("/api/sessions", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("세션 API 응답이 실패했습니다.");
    }
    const data = await response.json();
    state.data = data;
    for (const session of data.sessions) {
      if (!state.initializedRootIds.has(session.id)) {
        state.expanded.add(session.id);
        state.initializedRootIds.add(session.id);
      }
    }
    render(data);
    setRefreshState(`갱신 ${new Intl.DateTimeFormat("ko-KR", { timeStyle: "medium" }).format(new Date(data.generatedAt))}`);
  } catch (error) {
    if (!state.data) {
      elements.sessionList.replaceChildren(
        statePanel("error", "세션 정보를 읽지 못했습니다", "Codex가 설치되어 있고 로컬 상태 DB에 접근 가능한지 확인한 뒤 다시 시도해 주세요."),
      );
    }
    setRefreshState("새로 고침 실패");
  } finally {
    state.isLoading = false;
    elements.refreshButton.disabled = false;
  }
}

elements.refreshButton.addEventListener("click", () => load());
elements.hideCompleted.addEventListener("change", (event) => {
  state.hideCompleted = event.target.checked;
  if (state.data) {
    renderSessions(state.data);
  }
});

load();
window.setInterval(() => load({ background: true }), 5000);
