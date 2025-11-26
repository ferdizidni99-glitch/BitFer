/** host-batcher-smart.js
 * Smarter host-side batcher:
 * - computes threads for one HWGW batch (accurately when ns.formulas available)
 * - computes RAM per batch, then decides how many concurrent batches to run to fill free RAM
 * - scales threads down/up proportionally if needed
 * - schedules batches with small offsets to avoid finish collisions
 *
 * Usage: run host-batcher-smart.js <target> [hackPercent] [maxTotalHackPct]
 *   hackPercent: desired % stolen per *single* batch (default 0.02)
 *   maxTotalHackPct: safety cap for combined concurrent batches (default 0.20)
 *
 * Designed to run 1 thread on host (controller deploys 1 thread per purchased server).
 */

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("sleep");
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run host-batcher-smart.js <target> [hackPct=0.02] [maxTotalHackPct=0.20]");
        return;
    }

    // Config
    let BASE_HACK_PCT = Math.min(0.25, Number(ns.args[1]) || 0.02); // per-batch baseline
    const MAX_TOTAL_HACK_PCT = Math.min(0.5, Number(ns.args[2]) || 0.20); // safety cap total across concurrent batches
    const DELTA = 250;      // ms gap between finishes inside a batch
    const BUFFER = 1400;    // ms buffer before base finish time
    const LOOP_DELAY = 900; // wait between scheduling waves
    const MIN_FREE_RAM_RATIO = 0.01; // leave a tiny cushion

    // heuristics (fallback)
    const SEC_INC_HACK = 0.002;
    const SEC_INC_GROW = 0.004;
    const SEC_DEC_WEAK = 0.05;

    const host = ns.getHostname();

    // helper safe format
    const fmt = (v) => {
        if (typeof ns.formatMoney === "function") return ns.formatMoney(v);
        if (typeof ns.formatNumber === "function") return ns.formatNumber(v);
        return String(Math.round(v));
    };

    while (true) {
        try {
            if (!ns.serverExists(target)) {
                ns.tprint(`host-batcher-smart (${host}): target ${target} missing -> exit`);
                return;
            }

            // times (ms)
            const hackTime = ns.getHackTime(target);
            const growTime = ns.getGrowTime(target);
            const weakenTime = ns.getWeakenTime(target);
            const longest = Math.max(hackTime, growTime, weakenTime);

            // find per-thread effect & threads using formulas when available
            let perHack = ns.hackAnalyze(target);
            let hackThreads = Math.max(1, Math.ceil(BASE_HACK_PCT / Math.max(1e-12, perHack)));

            // estimate grow threads - prefer formulas if available
            let growThreads = 1;
            const hackedFraction = Math.min(0.999, hackThreads * perHack);
            const growthFactor = 1 / Math.max(1e-9, (1 - hackedFraction));
            try {
                // use built-in growthAnalyze if present (most BB versions have it)
                growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growthFactor)));
            } catch {
                // fallback rough estimate: arbitrary small multiplier
                growThreads = Math.max(1, Math.ceil(Math.log(growthFactor) / Math.log(1 + 0.03)));
            }

            // security delta heuristics (fallback)
            let secIncHack = hackThreads * SEC_INC_HACK;
            let secIncGrow = growThreads * SEC_INC_GROW;
            let weaken1Threads = Math.max(1, Math.ceil(secIncHack / SEC_DEC_WEAK));
            let weaken2Threads = Math.max(1, Math.ceil(secIncGrow / SEC_DEC_WEAK));

            // If ns.formulas.hacking exists, try to refine thread estimates (best-effort)
            if (ns.formulas && ns.formulas.hacking) {
                try {
                    const player = ns.getPlayer ? ns.getPlayer() : null;
                    // some BB versions provide ns.formulas.hacking.hackPercent/server/player
                    // fallbacks maintained; we only attempt to refine perHack if available
                    if (typeof ns.formulas.hacking.hackPercent === "function") {
                        const fp = ns.formulas.hacking.hackPercent(ns.getServer(target), player);
                        if (fp > 0) perHack = fp;
                        // recompute hackThreads with refined perHack
                        hackThreads = Math.max(1, Math.ceil(BASE_HACK_PCT / Math.max(1e-12, perHack)));
                    }
                    // other formulas could be used for security delta but versions differ; keep heuristics
                } catch (e) {
                    // ignore and use heuristics
                }
            }

            // compute RAM per batch (for these thread counts)
            const ramHack = ns.getScriptRam("hack.js");
            const ramGrow = ns.getScriptRam("grow.js");
            const ramWeaken = ns.getScriptRam("weaken.js");

            let ramPerBatch = hackThreads * ramHack + growThreads * ramGrow + (weaken1Threads + weaken2Threads) * ramWeaken;

            // free RAM on host (keep tiny cushion)
            const hostMaxRam = ns.getServerMaxRam(host);
            const hostUsedRam = ns.getServerUsedRam(host);
            const freeRam = Math.max(0, hostMaxRam - hostUsedRam - Math.max(0, hostMaxRam * MIN_FREE_RAM_RATIO));

            if (ramPerBatch <= 0) ramPerBatch = 1;

            // compute concurrency: how many identical batches can we run in parallel (initial)
            let concurrency = Math.max(1, Math.floor(freeRam / ramPerBatch));

            // Compute total hack% across concurrency; if exceeds MAX_TOTAL_HACK_PCT, reduce per-batch hackPct
            let totalHackPct = concurrency * BASE_HACK_PCT;
            if (totalHackPct > MAX_TOTAL_HACK_PCT) {
                // limit total and recompute per-batch
                const perBatchAllowed = Math.max(0.001, MAX_TOTAL_HACK_PCT / concurrency);
                // recompute hackThreads for new per-batch percent
                BASE_HACK_PCT = perBatchAllowed;
                hackThreads = Math.max(1, Math.ceil(BASE_HACK_PCT / Math.max(1e-12, perHack)));
                // recompute related numbers
                const hackedFraction2 = Math.min(0.999, hackThreads * perHack);
                const growthFactor2 = 1 / Math.max(1e-9, (1 - hackedFraction2));
                try {
                    growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growthFactor2)));
                } catch {
                    growThreads = Math.max(1, Math.ceil(Math.log(growthFactor2) / Math.log(1 + 0.03)));
                }
                secIncHack = hackThreads * SEC_INC_HACK;
                secIncGrow = growThreads * SEC_INC_GROW;
                weaken1Threads = Math.max(1, Math.ceil(secIncHack / SEC_DEC_WEAK));
                weaken2Threads = Math.max(1, Math.ceil(secIncGrow / SEC_DEC_WEAK));
                ramPerBatch = hackThreads * ramHack + growThreads * ramGrow + (weaken1Threads + weaken2Threads) * ramWeaken;
                concurrency = Math.max(1, Math.floor(freeRam / ramPerBatch));
                totalHackPct = concurrency * BASE_HACK_PCT;
            }

            // If concurrency == 0 (not enough RAM even for a minimal batch), scale down threads proportionally
            if (concurrency <= 0 || ramPerBatch > freeRam) {
                // scale factor to fit freeRam
                const scale = Math.max(0.01, freeRam / ramPerBatch);
                const scaleRound = v => Math.max(1, Math.floor(v * scale));
                const old = { hackThreads, growThreads, weaken1Threads, weaken2Threads };
                hackThreads = scaleRound(hackThreads);
                growThreads = scaleRound(growThreads);
                weaken1Threads = scaleRound(weaken1Threads);
                weaken2Threads = scaleRound(weaken2Threads);
                ramPerBatch = hackThreads * ramHack + growThreads * ramGrow + (weaken1Threads + weaken2Threads) * ramWeaken;
                concurrency = Math.max(1, Math.floor(freeRam / ramPerBatch));
            }

            // Final safety: ensure we don't schedule insane concurrency
            concurrency = Math.max(1, Math.min(concurrency, Math.floor(Math.max(1, freeRam / Math.max(1, ramPerBatch)))));

            // Now schedule 'concurrency' batches, each with a slightly different T offset so finishes don't collide directly
            const now = Date.now();
            const baseT = now + longest + BUFFER;
            for (let b = 0; b < concurrency; b++) {
                // small offset per batch (spread across DELTA*4 window)
                const batchOffset = Math.round((b / Math.max(1, concurrency)) * (DELTA * 4));
                const T = baseT + batchOffset;

                // compute start delays for this batch
                const hackStartDelay = Math.max(0, Math.round((T - hackTime) - Date.now()));
                const weaken1StartDelay = Math.max(0, Math.round((T + DELTA - weakenTime) - Date.now()));
                const growStartDelay = Math.max(0, Math.round((T + 2 * DELTA - growTime) - Date.now()));
                const weaken2StartDelay = Math.max(0, Math.round((T + 3 * DELTA - weakenTime) - Date.now()));

                // exec scripts (they will sleep until their start delay)
                if (hackThreads > 0) ns.exec("hack.js", host, hackThreads, target, hackStartDelay);
                if (weaken1Threads > 0) ns.exec("weaken.js", host, weaken1Threads, target, weaken1StartDelay);
                if (growThreads > 0) ns.exec("grow.js", host, growThreads, target, growStartDelay);
                if (weaken2Threads > 0) ns.exec("weaken.js", host, weaken2Threads, target, weaken2StartDelay);
            }

            ns.print(`host-batcher-smart(${host})->${target} scheduled: perBatch(h=${hackThreads},g=${growThreads},w1=${weaken1Threads},w2=${weaken2Threads}), concurrency=${concurrency}, perBatchRam=${Math.round(ramPerBatch)}, freeRam=${Math.round(freeRam)}, totalHackPct=${(concurrency*BASE_HACK_PCT).toFixed(4)}`);

            // wait a bit before next scheduling wave
            await ns.sleep(LOOP_DELAY + Math.floor(Math.random() * 400));
        } catch (e) {
            ns.print("host-batcher-smart error: " + String(e));
            await ns.sleep(1500);
        }
    }
}
