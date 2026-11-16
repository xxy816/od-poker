/**
 * 奖池分配（纯函数，便于单测）
 *
 * 设计要点：
 * 1. 边池按"所有实际投入过筹码的玩家"计算，包括已弃牌、已离桌的玩家，
 *    否则这些筹码会凭空消失。
 * 2. 每个边池只有"未弃牌且在座"的玩家有资格争夺。
 * 3. 平分时用整数除法，余数逐个发给靠前的赢家，保证筹码守恒。
 * 4. 若传入的 pot 与投入明细不一致，按 pot 为准做对账，保证不创造/不销毁筹码。
 */

/**
 * 把 total 均分成 count 份（整数），余数依次分给前几份
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
function splitAmount(total, count) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count <= 0) {
    return [];
  }

  const base = Math.floor(total / count);
  let remainder = total - base * count;

  return Array.from({ length: count }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return base + extra;
  });
}

/**
 * 归一化投入明细（支持 Map 或普通对象）
 * @param {Map|Object} contributions - playerId -> 本局累计投入
 * @returns {Map<string, number>}
 */
function normalizeContributions(contributions) {
  const result = new Map();

  if (!contributions) return result;

  const entries = contributions instanceof Map
    ? Array.from(contributions.entries())
    : Object.entries(contributions);

  for (const [playerId, amount] of entries) {
    const value = Number(amount);
    if (Number.isFinite(value) && value > 0) {
      result.set(playerId, Math.round(value));
    }
  }

  return result;
}

/**
 * 分配奖池
 * @param {Object} params
 * @param {number} params.pot - 底池总额（权威值）
 * @param {Map|Object} params.contributions - 所有玩家的累计投入（含弃牌/离桌玩家）
 * @param {Array<{player: Object, hand: Object}>} params.playerHands - 有资格争夺的玩家及其牌型
 * @returns {Array} 每个奖池的分配结果，形如
 *   [{ potType: 'main', amount, winners: [{ player, hand, winAmount }] }]
 */
function distributePots({ pot, contributions, playerHands }) {
  const totalPot = Math.max(0, Math.round(Number(pot) || 0));
  const hands = Array.isArray(playerHands)
    ? playerHands.filter((ph) => ph && ph.player && ph.hand)
    : [];

  if (hands.length === 0 || totalPot === 0) return [];

  const contributionMap = normalizeContributions(contributions);
  const contributionOf = (playerId) => contributionMap.get(playerId) || 0;

  // 所有投入档位（升序），每个档位切出一层边池
  const levels = [...new Set(Array.from(contributionMap.values()))].sort((a, b) => a - b);

  const pots = [];
  let previousLevel = 0;

  for (const level of levels) {
    const tier = level - previousLevel;
    previousLevel = level;

    if (tier <= 0) continue;

    const contributors = Array.from(contributionMap.keys())
      .filter((playerId) => contributionOf(playerId) >= level);
    const amount = tier * contributors.length;
    const eligibleHands = hands.filter((ph) => contributionOf(ph.player.id) >= level);

    if (amount > 0 && eligibleHands.length > 0) {
      pots.push({ level, amount, eligibleHands });
    }
  }

  // 兜底：没有任何可分配的档位时，整池给所有有资格的玩家
  if (pots.length === 0) {
    pots.push({ level: 0, amount: totalPot, eligibleHands: hands });
  }

  // 对账：以 pot 为权威，超出部分并入主池，多算的部分从边池回退
  const totalInPots = pots.reduce((sum, p) => sum + p.amount, 0);
  const diff = totalPot - totalInPots;

  if (diff > 0) {
    pots[0].amount += diff;
  } else if (diff < 0) {
    let overflow = -diff;
    for (let i = pots.length - 1; i >= 0 && overflow > 0; i--) {
      const cut = Math.min(overflow, pots[i].amount);
      pots[i].amount -= cut;
      overflow -= cut;
    }
  }

  const results = [];
  let potIndex = 0;

  for (const potItem of pots) {
    if (potItem.amount <= 0) continue;

    const bestValue = Math.max(...potItem.eligibleHands.map((ph) => ph.hand.value));
    const winners = potItem.eligibleHands.filter((ph) => ph.hand.value === bestValue);
    if (winners.length === 0) continue;

    const shares = splitAmount(potItem.amount, winners.length);

    results.push({
      potType: potIndex === 0 ? 'main' : `side${potIndex}`,
      amount: potItem.amount,
      winners: winners.map((winner, index) => ({
        player: winner.player,
        hand: winner.hand,
        winAmount: shares[index]
      }))
    });

    potIndex++;
  }

  return results;
}

/**
 * 统计一次分配结果里实际发出的筹码总额
 * @param {Array} potResults
 * @returns {number}
 */
function totalDistributed(potResults) {
  return (potResults || []).reduce(
    (sum, result) => sum + result.winners.reduce((s, w) => s + w.winAmount, 0),
    0
  );
}

module.exports = {
  distributePots,
  splitAmount,
  totalDistributed
};
