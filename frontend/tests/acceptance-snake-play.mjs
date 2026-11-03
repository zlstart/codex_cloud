// Behavioral checks for the real generated artifact. Source/state are never modified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");
export async function readSnakeBoard(target) {
  return target.evaluate(() => {
    const canvas = document.querySelector("#board");
    const ctx = canvas.getContext("2d");
    const occupied = [];
    let head = null, food = null;
    // Read visible cell colors from the model's canvas; do not access/mutate game state.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const [r, g, b] = ctx.getImageData(Math.floor((x + 0.5) * canvas.width / 20), Math.floor((y + 0.5) * canvas.height / 20), 1, 1).data;
      // The generated head draws an eye over the cell center; sample its upper-left fill.
      const [hr, hg, hb] = ctx.getImageData(Math.floor((x + 0.25) * canvas.width / 20), Math.floor((y + 0.25) * canvas.height / 20), 1, 1).data;
      if (hr === 125 && hg === 243 && hb === 192) { head = { x, y }; occupied.push({ x, y }); }
      else if (r < 100 && g > 100 && b > 100) occupied.push({ x, y });
      else if (r > 180 && r > g * 1.35 && r > b * 1.3) food = { x, y };
    }
    return { head, food, occupied, score: Number(document.querySelector("#scoreVal").textContent), length: Number(document.querySelector("#lenVal").textContent), status: document.querySelector("#statusBadge").dataset.state, status_text: document.querySelector("#statusText").textContent };
  });
}

async function moved(target, page, previous, predicate = () => true) {
  const deadline = Date.now() + 1500;
  let last;
  while (Date.now() < deadline) {
    const board = await readSnakeBoard(target);
    last = board;
    if (board.status === "over") throw new Error(`Game ended before expected movement: ${board.status_text}`);
    if (board.head && (!previous || board.head.x !== previous.x || board.head.y !== previous.y) && predicate(board.head)) return board;
    await page.waitForTimeout(20);
  }
  throw new Error(`Expected visible snake movement did not occur: ${JSON.stringify({ previous, last })}`);
}

function nextMove(board) {
  const key = ({ x, y }) => `${x},${y}`;
  const blocked = new Set(board.occupied.map(key));
  blocked.delete(key(board.head));
  const queue = [{ ...board.head, first: null }], seen = new Set([key(board.head)]);
  const directions = [[0, -1, "ArrowUp"], [1, 0, "ArrowRight"], [0, 1, "ArrowDown"], [-1, 0, "ArrowLeft"]];
  while (queue.length) {
    const cell = queue.shift();
    if (cell.x === board.food.x && cell.y === board.food.y) return cell.first;
    for (const [dx, dy, direction] of directions) {
      const next = { x: cell.x + dx, y: cell.y + dy, first: cell.first ?? direction };
      const id = key(next);
      if (next.x < 0 || next.y < 0 || next.x >= 20 || next.y >= 20 || blocked.has(id) || seen.has(id)) continue;
      seen.add(id); queue.push(next);
    }
  }
  return null;
}

export async function playSnake({ target, page, screenshot, mobile = false }) {
  const results = { method: "Real buttons/keyboard/touch only; canvas pixels and visible score/status read without state mutation", checks: [], scoring_attempts: [] };
  const check = (name, evidence) => { results.checks.push({ name, passed: true, evidence }); console.log(`GAME_CHECK ${name}`); };
  await target.locator("#mainBtn").waitFor();
  assert.equal(await target.locator("#statusBadge").getAttribute("data-state"), "ready");
  await screenshot("initial");
  if (mobile) {
    await target.locator('[data-dir="up"]').tap();
    const up = await moved(target, page, { x: 6, y: 10 }, (head) => head.y < 10);
    await target.locator('[data-dir="left"]').tap();
    const left = await moved(target, page, up.head, (head) => head.x < up.head.x);
    check("touch_controls_start_and_turn", { up: up.head, left: left.head });
  } else {
    await target.locator("#mainBtn").click();
    const first = await moved(target, page, { x: 6, y: 10 });
    check("start_and_automatic_movement", first);
    await page.keyboard.press("ArrowUp");
    const up = await moved(target, page, first.head, (head) => head.y < first.head.y);
    await page.keyboard.press("ArrowDown");
    const noReverse = await moved(target, page, up.head, (head) => head.y < up.head.y);
    check("arrow_controls_and_reverse_prevention", { up: up.head, after_opposite_key: noReverse.head });
    await page.keyboard.press("a");
    const left = await moved(target, page, noReverse.head, (head) => head.x < noReverse.head.x);
    check("wasd_controls", left.head);
  }
  const beforePause = await readSnakeBoard(target);
  await target.locator("#mainBtn")[mobile ? "tap" : "click"]();
  assert.equal(await target.locator("#statusBadge").getAttribute("data-state"), "paused");
  const paused1 = await target.locator("#board").evaluate((canvas) => canvas.toDataURL());
  await page.waitForTimeout(450);
  const paused2 = await target.locator("#board").evaluate((canvas) => canvas.toDataURL());
  assert.equal(paused1, paused2, "Paused board remains pixel-identical");
  check("pause_stops_board", { board_sha256: hash(paused1) });
  await screenshot("paused");
  if (mobile) {
    await target.locator("#board").scrollIntoViewIfNeeded();
    await screenshot("paused-board");
  }
  await target.locator("#mainBtn")[mobile ? "tap" : "click"]();
  const resumed = await moved(target, page, beforePause.head);
  check("resume_moves_again", resumed.head);
  await target.locator("#restartBtn")[mobile ? "tap" : "click"]();
  assert.equal(await target.locator("#statusBadge").getAttribute("data-state"), "ready");
  assert.equal(await target.locator("#scoreVal").textContent(), "0");
  assert.equal(await target.locator("#lenVal").textContent(), "3");
  check("restart_resets_score_length_and_status", { score: 0, length: 3, status: "ready" });

  if (!mobile) {
    let scored = false;
    for (let attempt = 1; attempt <= 3 && !scored; attempt++) {
      try {
        await target.locator("#restartBtn").click();
        await target.locator("#mainBtn").click();
        // Wait for the first actual animation tick; status updates before the canvas redraw.
        let board = await moved(target, page, { x: 6, y: 10 });
        for (let step = 0; step < 65 && board.score === 0; step++) {
          assert.ok(board.head && board.food, "Visible head and food can be read from canvas");
          const direction = nextMove(board);
          assert.ok(direction, "A legal visible route to food exists");
          await page.keyboard.press(direction);
          board = await moved(target, page, board.head);
        }
        assert.ok(board.score > 0 && board.length > 3, "Eating food increases visible score and length");
        if (await target.locator("#statusBadge").getAttribute("data-state") === "running") await target.locator("#mainBtn").click();
        assert.equal(await target.locator("#statusBadge").getAttribute("data-state"), "paused");
        results.scoring_attempts.push({ attempt, passed: true, score: board.score, length: board.length });
        check("keyboard_play_eats_food_and_scores", board);
        await screenshot("scored");
        scored = true;
      } catch (error) { results.scoring_attempts.push({ attempt, passed: false, error: error.message }); console.log(`SCORING_ATTEMPT ${JSON.stringify(results.scoring_attempts.at(-1))}`); }
    }
    assert.ok(scored, `Real keyboard play achieved a positive score: ${JSON.stringify(results.scoring_attempts)}`);
    await target.locator("#restartBtn").click();
    await target.locator("#mainBtn").click();
    await target.locator('#statusBadge[data-state="over"]').waitFor({ timeout: 10_000 });
    const collision = await target.locator("#statusText").textContent();
    assert.match(collision, /撞墙/);
    check("wall_collision_ends_game", { status: collision });
    await screenshot("collision");
    await target.locator("#restartBtn").click();
    assert.equal(await target.locator("#scoreVal").textContent(), "0");
    assert.equal(await target.locator("#statusBadge").getAttribute("data-state"), "ready");
    check("restart_after_game_over", { status: "ready", score: 0 });
  }
  return results;
}
