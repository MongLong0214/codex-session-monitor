import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const dashboardFixture = path.join(testDirectory, "fixtures", "dashboard.json");
const emptyFixture = path.join(testDirectory, "fixtures", "empty-dashboard.json");

let browser;
let dashboardServer;

function startServer(fixturePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PORT: "0",
        CODEX_SESSION_MONITOR_FIXTURE: fixturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`테스트 서버가 시작되지 않았습니다: ${output}`));
      }
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, url: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`테스트 서버가 조기 종료됐습니다 (${code}): ${output}`));
      }
    });
  });
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) {
    return;
  }

  const stopped = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await stopped;
}

async function openDashboard(t, viewport) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  t.after(() => page.close());
  await page.goto(dashboardServer.url, { waitUntil: "networkidle" });
  await page.locator(".session-card").first().waitFor();
  return { page, consoleErrors, failedRequests };
}

async function phrasesThatCrossLines(page, selector, phrases) {
  return page.locator(selector).evaluateAll((nodes, expectedPhrases) => {
    function textNodesWithin(node) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }
      return textNodes;
    }

    function rangeForPhrase(node, phrase) {
      const textNodes = textNodesWithin(node);
      const wholeText = textNodes.map((textNode) => textNode.textContent || "").join("");
      const phraseStart = wholeText.indexOf(phrase);
      if (phraseStart < 0) {
        return null;
      }

      const phraseEnd = phraseStart + phrase.length;
      let cursor = 0;
      let start;
      let end;
      for (const textNode of textNodes) {
        const length = textNode.textContent?.length || 0;
        if (!start && phraseStart >= cursor && phraseStart <= cursor + length) {
          start = { textNode, offset: phraseStart - cursor };
        }
        if (!end && phraseEnd >= cursor && phraseEnd <= cursor + length) {
          end = { textNode, offset: phraseEnd - cursor };
        }
        cursor += length;
      }

      if (!start || !end) {
        return null;
      }

      const range = document.createRange();
      range.setStart(start.textNode, start.offset);
      range.setEnd(end.textNode, end.offset);
      return range;
    }

    return expectedPhrases.filter((phrase) =>
      nodes.some((node) => {
        const range = rangeForPhrase(node, phrase);
        return range && [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).length > 1;
      }),
    );
  }, phrases);
}

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
}

before(async () => {
  browser = await chromium.launch({ headless: true });
  dashboardServer = await startServer(dashboardFixture);
});

after(async () => {
  await Promise.all([browser?.close(), stopServer(dashboardServer)]);
});

test("데스크톱에서 런타임 패널은 세션 열과 겹치지 않고 스크롤에 고정되지 않는다", async (t) => {
  const { page, consoleErrors, failedRequests } = await openDashboard(t, { width: 1440, height: 900 });

  assert.equal(await page.locator(".session-card").count(), 2);
  assert.equal(await page.locator(".agent-node").count(), 5);
  assert.equal(await page.getByText("데이터 담당", { exact: true }).count(), 1);
  assert.equal(await page.getByText("검토 담당", { exact: true }).count(), 1);
  assert.equal(await page.locator(".agent-id").first().getAttribute("title"), "root-research");
  assert.equal(await page.locator(".session-meta code").first().getAttribute("title"), "root-research");

  const before = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const runtime = document.querySelector(".runtime-panel");
    return {
      sessionRight: rect(".session-section").right,
      runtimeLeft: rect(".runtime-panel").left,
      runtimeTop: rect(".runtime-panel").top,
      position: getComputedStyle(runtime).position,
      zIndex: getComputedStyle(runtime).zIndex,
    };
  });

  assert.equal(before.position, "static");
  assert.equal(before.zIndex, "auto");
  assert.ok(before.sessionRight < before.runtimeLeft, "세션 열이 런타임 패널 영역을 침범하면 안 됩니다.");
  const overflowingActivityText = await page.locator(".activity-text").evaluateAll(
    (nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length,
  );
  assert.equal(overflowingActivityText, 0, "긴 활동 텍스트가 현재 세션 카드 폭을 넘기면 안 됩니다.");
  assert.deepEqual(
    await phrasesThatCrossLines(page, ".session-card-title, .activity-text", ["이\u00a0이미지", "보고해 줘", "사람들이", "뽑아 줘", "video-art"]),
    [],
    "데스크톱 제목에서 한국어 어절과 짧은 서술어가 줄 사이에 분리되면 안 됩니다.",
  );

  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForFunction(() => window.scrollY > 0);
  const afterTop = await page.locator(".runtime-panel").evaluate((panel) => panel.getBoundingClientRect().top);
  assert.ok(afterTop < before.runtimeTop - 100, "런타임 패널은 스크롤에 따라 문서와 함께 이동해야 합니다.");
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedRequests, []);
});

test("트리 접기, 완료 필터, 새로 고침이 실제 화면에서 일관되게 동작한다", async (t) => {
  const { page, consoleErrors, failedRequests } = await openDashboard(t, { width: 1280, height: 900 });
  const toggle = page.getByRole("button", { name: "하위 3명 접기" });

  await toggle.click();
  const collapsedToggle = page.getByRole("button", { name: "하위 3명 펼치기" });
  assert.equal(await collapsedToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByText("데이터 담당", { exact: true }).count(), 0);
  assert.equal(await collapsedToggle.count(), 1);

  await page.waitForTimeout(5200);
  assert.equal(await collapsedToggle.count(), 1, "자동 새로 고침 뒤에도 사용자가 접은 트리를 유지해야 합니다.");

  await collapsedToggle.click();
  assert.equal(await page.getByText("데이터 담당", { exact: true }).count(), 1);

  await page.locator("#hide-completed").check();
  assert.equal(await page.locator(".status-completed").count(), 0);
  assert.equal(await page.getByText("검토 담당", { exact: true }).count(), 0);
  await page.locator("#hide-completed").uncheck();
  assert.equal(await page.getByText("검토 담당", { exact: true }).count(), 1);

  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/sessions") && candidate.status() === 200);
  await page.getByRole("button", { name: "지금 새로 고침" }).click();
  assert.equal((await response).status(), 200);
  assert.match(await page.locator("#refresh-state").textContent(), /^갱신 /);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedRequests, []);
});

test("모바일에서 가로 오버플로 없이 세션 뒤에 런타임 목록을 배치한다", async (t) => {
  const { page, consoleErrors, failedRequests } = await openDashboard(t, { width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const session = document.querySelector(".session-section").getBoundingClientRect();
    const runtime = document.querySelector(".runtime-panel").getBoundingClientRect();
    const cardOverflow = [...document.querySelectorAll(".session-card")].some(
      (card) => card.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
    );
    return {
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      sessionBottom: session.bottom,
      runtimeTop: runtime.top,
      runtimePosition: getComputedStyle(document.querySelector(".runtime-panel")).position,
      cardOverflow,
    };
  });

  assert.ok(layout.scrollWidth <= layout.clientWidth, "모바일 본문에 가로 스크롤이 생기면 안 됩니다.");
  assert.equal(layout.cardOverflow, false);
  assert.equal(layout.runtimePosition, "static");
  assert.ok(layout.runtimeTop >= layout.sessionBottom, "모바일 런타임 목록은 세션 목록 뒤에 와야 합니다.");
  const overflowingActivityText = await page.locator(".activity-text").evaluateAll(
    (nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length,
  );
  assert.equal(overflowingActivityText, 0, "모바일 활동 텍스트가 카드 폭을 넘기면 안 됩니다.");
  assert.deepEqual(
    await phrasesThatCrossLines(page, ".session-card-title, .activity-text", ["이\u00a0이미지", "보고해 줘", "사람들이", "뽑아 줘", "video-art"]),
    [],
    "모바일 제목에서 한국어 어절과 짧은 서술어가 줄 사이에 분리되면 안 됩니다.",
  );
  const splitPathSegments = await phrasesThatCrossLines(page, ".session-path", ["video-art"]);
  assert.deepEqual(splitPathSegments, [], "경로의 한 세그먼트는 슬래시가 아닌 중간에서 분리되면 안 됩니다.");
  const splitAgentMetaPath = await phrasesThatCrossLines(page, ".agent-meta", ["video-art"]);
  assert.deepEqual(splitAgentMetaPath, [], "에이전트 메타데이터 경로도 슬래시가 아닌 중간에서 분리되면 안 됩니다.");
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedRequests, []);
});

test("빈 스냅샷에서도 빈 상태와 런타임 빈 상태를 표시한다", async (t) => {
  const emptyServer = await startServer(emptyFixture);
  t.after(() => stopServer(emptyServer));
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  t.after(() => page.close());
  await page.goto(emptyServer.url, { waitUntil: "networkidle" });

  assert.equal(await page.locator(".session-card").count(), 0);
  assert.equal(await page.getByText("표시할 현재 세션이 없습니다", { exact: true }).count(), 1);
  assert.equal(await page.getByText("실행 중인 Codex가 없습니다", { exact: true }).count(), 1);
  assert.deepEqual(
    await phrasesThatCrossLines(page, ".empty-copy", ["PID와"]),
    [],
    "빈 런타임 안내에서 PID와 같은 짧은 결합 어절이 줄 사이에 분리되면 안 됩니다.",
  );
});

test("API와 정적 경로는 기대한 상태 코드로 응답한다", async () => {
  const snapshotResponse = await fetch(`${dashboardServer.url}/api/sessions`);
  assert.equal(snapshotResponse.status, 200);
  assert.equal((await snapshotResponse.json()).summary.agents, 5);

  const missingResponse = await fetch(`${dashboardServer.url}/does-not-exist`);
  assert.equal(missingResponse.status, 404);

  const foreignHostResponse = await requestWithHost(`${dashboardServer.url}/api/sessions`, "attacker.example:4179");
  assert.equal(foreignHostResponse.statusCode, 403);
});
