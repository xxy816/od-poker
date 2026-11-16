// 奖池分配单元测试：node scripts/testPots.js
const assert = require('assert');
const { distributePots, splitAmount, totalDistributed } = require('../services/potService');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function hand(value) {
  return { value, type: value };
}

function player(id, name = id) {
  return { id, name, chips: 0, folded: false, allIn: false };
}

console.log('splitAmount');
test('整除', () => {
  assert.deepStrictEqual(splitAmount(100, 2), [50, 50]);
});
test('余数按顺序补足', () => {
  assert.deepStrictEqual(splitAmount(101, 2), [51, 50]);
  assert.deepStrictEqual(splitAmount(102, 4), [26, 26, 25, 25]);
});
test('总和不丢失', () => {
  for (const total of [1, 7, 100, 101, 999]) {
    for (const count of [1, 2, 3, 4, 5]) {
      const shares = splitAmount(total, count);
      assert.strictEqual(shares.reduce((a, b) => a + b, 0), total, `${total}/${count}`);
    }
  }
});
test('非法输入返回空', () => {
  assert.deepStrictEqual(splitAmount(0, 2), []);
  assert.deepStrictEqual(splitAmount(10, 0), []);
});

console.log('distributePots');
test('无全下：赢家拿走整个底池', () => {
  const a = player('A');
  const b = player('B');
  const results = distributePots({
    pot: 100,
    contributions: { A: 50, B: 50 },
    playerHands: [{ player: a, hand: hand(9) }, { player: b, hand: hand(5) }]
  });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].potType, 'main');
  assert.strictEqual(results[0].winners[0].player.id, 'A');
  assert.strictEqual(totalDistributed(results), 100);
});

test('无全下且牌型相同：底池平分且余数不丢', () => {
  const results = distributePots({
    pot: 101,
    contributions: { A: 51, B: 50 },
    playerHands: [
      { player: player('A'), hand: hand(7) },
      { player: player('B'), hand: hand(7) }
    ]
  });
  assert.strictEqual(totalDistributed(results), 101);
  assert.strictEqual(results[0].winners.length, 2);
});

test('弃牌玩家的投入仍进入主池（不再被吞掉）', () => {
  // A 全下 100，B 跟注 100，C 弃牌前已投 50：底池 250
  const a = player('A');
  const b = player('B');
  const results = distributePots({
    pot: 250,
    contributions: { A: 100, B: 100, C: 50 },
    playerHands: [{ player: a, hand: hand(10) }, { player: b, hand: hand(3) }]
  });
  assert.strictEqual(totalDistributed(results), 250);
  // 主池 50*3=150 + 边池 50*2=100 全归 A
  const byA = results.reduce(
    (sum, r) => sum + r.winners.filter(w => w.player.id === 'A').reduce((s, w) => s + w.winAmount, 0),
    0
  );
  assert.strictEqual(byA, 250);
});

test('短码全下只能赢主池，边池归更深筹码的赢家', () => {
  // A 全下 100（最强），B/C 各投 200（B 次强，C 最弱）：底池 500
  const a = player('A');
  const b = player('B');
  const c = player('C');
  const results = distributePots({
    pot: 500,
    contributions: { A: 100, B: 200, C: 200 },
    playerHands: [
      { player: a, hand: hand(10) },
      { player: b, hand: hand(8) },
      { player: c, hand: hand(2) }
    ]
  });
  assert.strictEqual(totalDistributed(results), 500);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].potType, 'main');
  assert.strictEqual(results[0].amount, 300); // 100*3
  assert.strictEqual(results[0].winners[0].player.id, 'A');
  assert.strictEqual(results[1].potType, 'side1');
  assert.strictEqual(results[1].amount, 200); // 100*2
  assert.strictEqual(results[1].winners[0].player.id, 'B');
});

test('已离桌玩家的投入仍会被分配（不会凭空消失）', () => {
  const a = player('A');
  const b = player('B');
  const results = distributePots({
    pot: 230,
    contributions: { A: 100, B: 100, LEFT: 30 },
    playerHands: [{ player: a, hand: hand(9) }, { player: b, hand: hand(4) }]
  });
  assert.strictEqual(totalDistributed(results), 230);
});

test('投入明细少于底池时按 pot 对账，不丢筹码', () => {
  const results = distributePots({
    pot: 120,
    contributions: { A: 60, B: 50 }, // 少了 10
    playerHands: [{ player: player('A'), hand: hand(9) }, { player: player('B'), hand: hand(1) }]
  });
  assert.strictEqual(totalDistributed(results), 120);
});

test('投入明细多于底池时不会多发光筹码', () => {
  const results = distributePots({
    pot: 100,
    contributions: { A: 100, B: 100 }, // 多了 100
    playerHands: [{ player: player('A'), hand: hand(9) }, { player: player('B'), hand: hand(1) }]
  });
  assert.strictEqual(totalDistributed(results), 100);
});

test('无人有资格时不分配（避免 throw）', () => {
  const results = distributePots({ pot: 100, contributions: { A: 100 }, playerHands: [] });
  assert.deepStrictEqual(results, []);
});

console.log(`\n全部通过（${passed} 项）`);
