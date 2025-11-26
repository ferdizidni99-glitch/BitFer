/** hacknet-manager-silent.js
 * Silent-by-default Hacknet manager (improved).
 *
 * Usage:
 *   run hacknet-manager-silent.js            (silent)
 *   run hacknet-manager-silent.js --verbose  (verbose logging)
 *   run hacknet-manager-silent.js --aggressive --verbose
 *
 * Behavior:
 *  - Uses production/sec (stats.production) when available
 *  - Computes payback time = cost / deltaProdPerSec
 *  - Prefers fastest payback; skips absurd payback by default
 *  - Default quiet mode (no tprint spam). Use --verbose to enable logs.
 */

export async function main(ns) {
    ns.disableLog("sleep");

    const ARGS = ns.args.map(String);
    const VERBOSE = ARGS.includes("--verbose");
    const AGGRESSIVE = ARGS.includes("--aggressive");
    const FORCE_SILENT = ARGS.includes("--silent");

    // QUIET default true unless --verbose passed
    const QUIET = !VERBOSE && !FORCE_SILENT;

    function tlog(...m) { if (!QUIET) ns.tprint(...m); }
    function vlog(...m) { if (VERBOSE) ns.tprint(...m); }
    function info(...m) { if (VERBOSE || !QUIET) ns.tprint(...m); }

    // ---------- CONFIG ----------
    const CFG = {
        SLEEP_MS: 30 * 1000,
        RESERVED_CASH_PCT: 0.20,
        BUDGET_RATIO: 0.70,
        MAX_ACTIONS_PER_CYCLE: 6,
        TARGET_NODE_COUNT: 24,
        MAX_NODE_LEVEL_UP_AT_ONCE: 10,
        MAX_NODE_RAM_UP_AT_ONCE: 4,
        MAX_NODE_CORE_UP_AT_ONCE: 4,
        MAX_PAYBACK_SECONDS: 30 * 24 * 3600, // 30 days
    };

    if (AGGRESSIVE) {
        // allow much longer payback when aggressive
        CFG.MAX_PAYBACK_SECONDS = 365 * 24 * 3600; // 1 year
    }

    function fmtMoney(v) {
        try { if (typeof ns.formatMoney === "function") return ns.formatMoney(v); } catch {}
        return "$" + abbreviateNumber(v);
    }
    function fmtTimeSec(s) {
        if (!isFinite(s) || s <= 0) return "∞";
        if (s < 60) return `${Math.round(s)}s`;
        const mins = s / 60;
        if (mins < 60) return `${(mins).toFixed(1)}m`;
        const hrs = mins / 60;
        if (hrs < 24) return `${(hrs).toFixed(2)}h`;
        const days = hrs / 24;
        return `${days.toFixed(2)}d`;
    }
    function abbreviateNumber(num) {
        if (num === 0) return "0";
        const abs = Math.abs(num);
        if (abs < 1000) return String(Math.round(num));
        const units = ["k","m","b","t","q"];
        let unit = -1;
        let n = num;
        while (Math.abs(n) >= 1000 && unit < units.length - 1) { n /= 1000; unit++; }
        return `${(Math.round(n * 100) / 100)}${units[Math.max(0,unit)]}`;
    }

    if (!QUIET) ns.tprint("🔧 hacknet-manager-silent started", VERBOSE ? "(verbose)" : "(silent)");

    while (true) {
        try {
            const homeMoney = ns.getServerMoneyAvailable("home");
            const reserved = homeMoney * CFG.RESERVED_CASH_PCT;
            let budget = Math.max(0, (homeMoney - reserved) * CFG.BUDGET_RATIO);

            if (budget < 1e6) {
                vlog("Budget too small:", fmtMoney(budget), "— sleeping");
                await ns.sleep(CFG.SLEEP_MS);
                continue;
            }

            let actions = 0;
            const nodeCount = ns.hacknet.numNodes();
            const purchaseCost = ns.hacknet.getPurchaseNodeCost();

            // collect node stats
            const nodes = [];
            for (let i = 0; i < nodeCount; i++) {
                const s = ns.hacknet.getNodeStats(i);
                nodes.push({
                    index: i,
                    level: s.level,
                    ram: s.ram,
                    cores: s.cores,
                    productionPerSec: (typeof s.production === "number") ? s.production : estimateProdFallback(s),
                    raw: s
                });
            }

            // build option list
            const options = [];

            // purchase candidate
            const estNewProd = estimateNewNodeProductionFromSample(nodes);
            if (nodeCount < 1000 && estNewProd > 0) {
                options.push({
                    type: "purchase",
                    cost: purchaseCost,
                    deltaProdPerSec: estNewProd,
                    paybackSec: purchaseCost / estNewProd,
                    desc: `purchase node (~${estNewProd.toFixed(3)}/s)`
                });
            }

            // upgrades per node
            for (const n of nodes) {
                const cur = n.productionPerSec;

                const lvlCost = ns.hacknet.getLevelUpgradeCost(n.index, 1);
                if (lvlCost > 0) {
                    const newStats = { level: n.level + 1, ram: n.ram, cores: n.cores };
                    const newProd = estimateProdUpgrade(n.raw, newStats);
                    const delta = Math.max(0, newProd - cur);
                    if (delta > 0) options.push({ type: "level", node: n.index, cost: lvlCost, deltaProdPerSec: delta, paybackSec: lvlCost / delta, desc: `level+1 node ${n.index}` });
                }

                const ramCost = ns.hacknet.getRamUpgradeCost(n.index, 1);
                if (ramCost > 0) {
                    const newStats = { level: n.level, ram: n.ram * 2, cores: n.cores };
                    const newProd = estimateProdUpgrade(n.raw, newStats);
                    const delta = Math.max(0, newProd - cur);
                    if (delta > 0) options.push({ type: "ram", node: n.index, cost: ramCost, deltaProdPerSec: delta, paybackSec: ramCost / delta, desc: `ram x2 node ${n.index}` });
                }

                const coreCost = ns.hacknet.getCoreUpgradeCost(n.index, 1);
                if (coreCost > 0) {
                    const newStats = { level: n.level, ram: n.ram, cores: n.cores + 1 };
                    const newProd = estimateProdUpgrade(n.raw, newStats);
                    const delta = Math.max(0, newProd - cur);
                    if (delta > 0) options.push({ type: "core", node: n.index, cost: coreCost, deltaProdPerSec: delta, paybackSec: coreCost / delta, desc: `core+1 node ${n.index}` });
                }
            }

            // filter & sort by payback
            let viable = options
                .filter(o => o.cost > 0 && o.deltaProdPerSec > 0)
                .filter(o => AGGRESSIVE ? true : (o.paybackSec <= CFG.MAX_PAYBACK_SECONDS))
                .sort((a, b) => a.paybackSec - b.paybackSec);

            // nudge purchase priority if below target node count
            if (nodeCount < CFG.TARGET_NODE_COUNT) {
                const pIdx = viable.findIndex(x => x.type === "purchase");
                if (pIdx > 0) {
                    const best = viable[0];
                    const pur = viable[pIdx];
                    if (pur && pur.paybackSec <= best.paybackSec * 2) {
                        viable.splice(pIdx, 1);
                        viable.unshift(pur);
                    }
                }
            }

            vlog("Candidates:", viable.length, "budget", fmtMoney(budget));

            // execute up to actions limit
            for (const opt of viable) {
                if (actions >= CFG.MAX_ACTIONS_PER_CYCLE) break;
                if (opt.cost > budget) continue;
                if (!AGGRESSIVE && opt.paybackSec > CFG.MAX_PAYBACK_SECONDS) {
                    vlog("Skipping due long payback:", opt.desc, fmtMoney(opt.cost), fmtTimeSec(opt.paybackSec));
                    continue;
                }

                if (opt.type === "purchase") {
                    const id = ns.hacknet.purchaseNode();
                    if (id !== -1) {
                        tlog(`🟢 Purchased node #${id} (cost ${fmtMoney(opt.cost)}, payback ${fmtTimeSec(opt.paybackSec)})`);
                        budget -= opt.cost;
                        actions++;
                    } else {
                        vlog("Purchase failed or insufficient funds");
                    }
                    continue;
                }

                if (opt.type === "level") {
                    let applied = 0;
                    for (let k = 0; k < CFG.MAX_NODE_LEVEL_UP_AT_ONCE; k++) {
                        const cost = ns.hacknet.getLevelUpgradeCost(opt.node, 1);
                        if (cost <= 0 || cost > budget) break;
                        const ok = ns.hacknet.upgradeLevel(opt.node, 1);
                        if (!ok) break;
                        budget -= cost;
                        applied++;
                        actions++;
                        if (actions >= CFG.MAX_ACTIONS_PER_CYCLE) break;
                    }
                    if (applied > 0) tlog(`⬆️ Level +${applied} node ${opt.node} (spent ≈ ${fmtMoney(applied * opt.cost)})`);
                    continue;
                }

                if (opt.type === "ram") {
                    let applied = 0;
                    for (let k = 0; k < CFG.MAX_NODE_RAM_UP_AT_ONCE; k++) {
                        const cost = ns.hacknet.getRamUpgradeCost(opt.node, 1);
                        if (cost <= 0 || cost > budget) break;
                        const ok = ns.hacknet.upgradeRam(opt.node, 1);
                        if (!ok) break;
                        budget -= cost;
                        applied++;
                        actions++;
                        if (actions >= CFG.MAX_ACTIONS_PER_CYCLE) break;
                    }
                    if (applied > 0) tlog(`⬆️ RAM x${applied} applied on node ${opt.node} (spent ≈ ${fmtMoney(applied * opt.cost)})`);
                    continue;
                }

                if (opt.type === "core") {
                    let applied = 0;
                    for (let k = 0; k < CFG.MAX_NODE_CORE_UP_AT_ONCE; k++) {
                        const cost = ns.hacknet.getCoreUpgradeCost(opt.node, 1);
                        if (cost <= 0 || cost > budget) break;
                        const ok = ns.hacknet.upgradeCore(opt.node, 1);
                        if (!ok) break;
                        budget -= cost;
                        applied++;
                        actions++;
                        if (actions >= CFG.MAX_ACTIONS_PER_CYCLE) break;
                    }
                    if (applied > 0) tlog(`🔥 Core +${applied} on node ${opt.node} (spent ≈ ${fmtMoney(applied * opt.cost)})`);
                    continue;
                }
            }

            if (!QUIET) info(`Cycle done. Nodes=${nodeCount}, actions=${actions}, remaining budget=${fmtMoney(budget)}`);
            await ns.sleep(CFG.SLEEP_MS);
        } catch (e) {
            ns.tprint("ERROR hacknet-manager-silent:", String(e));
            await ns.sleep(30 * 1000);
        }
    }

    // ---------------- helpers ----------------
    function estimateNewNodeProductionFromSample(nodes) {
        if (!nodes || nodes.length === 0) return 0.25;
        let sum = 0, cnt = 0;
        for (const n of nodes) { sum += n.productionPerSec; cnt++; }
        const avg = sum / Math.max(1, cnt);
        return avg * 0.85;
    }

    function estimateProdFallback(stats) {
        return stats.level * stats.ram * (1 + stats.cores / 10) * 0.01;
    }

    function estimateProdUpgrade(oldStats, newStats) {
        const cur = oldStats.production ?? estimateProdFallback(oldStats);
        const altOld = { level: oldStats.level, ram: oldStats.ram, cores: oldStats.cores };
        const altNew = { level: newStats.level, ram: newStats.ram, cores: newStats.cores };
        const fCur = estimateProdFallback(altOld);
        const fNew = estimateProdFallback(altNew);
        if (fCur > 0) {
            const ratio = (cur / fCur);
            return fNew * ratio;
        }
        return fNew;
    }
}
