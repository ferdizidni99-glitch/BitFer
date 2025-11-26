/** @param {NS} ns
 *  Smart multi-thread worker:
 *  - Works well when controller runs many threads of this script on a server.
 *  - Distributes hack work probabilistically so not all threads hack at once.
 *  - Prioritizes weaken -> grow -> hack.
 *  - Adds jitter and cooldowns to avoid sync spikes.
 */
export async function main(ns) {
    const args = ns.args;
    const target = String(args[0] ?? "");
    if (!target) {
        ns.tprint("Usage: run worker.js <target> [--verbose]");
        return;
    }

    const VERBOSE = args.includes("--verbose");

    const CFG = {
        SEC_MARGIN: 2.0,           // if sec > min+SEC_MARGIN -> weaken
        GROW_PCT: 0.85,            // if money < max * GROW_PCT -> grow
        HACK_SAFE_PCT: 0.90,       // only hack if money >= max * HACK_SAFE_PCT
        DESIRED_HACK_FRACTION: 0.02, // target total stolen fraction per 'round' (e.g. 2%)
        MIN_HACK_CHANCE: 0.20,     // minimum hackAnalyzeChance to allow hacking
        BASE_SLEEP_MS: 200,        // base sleep between loops
        JITTER_MS: 800,            // additional random sleep to avoid sync
        ERROR_SLEEP_MS: 5000,      // sleep on error
        PS_LOOKUP_CACHE_MS: 1500,  // cache ps() result this many ms to reduce overhead
    };

    const log = (...m) => { if (VERBOSE) ns.tprint("[worker] " + m.join(" ")); };

    // helper: abbreviated name of this script to find in ps
    const HOST = ns.getHostname();
    const SCRIPT_NAME = ns.getScriptName();

    // PS caching to limit frequent syscalls
    let psCache = null;
    let psCacheTime = 0;
    function getPs(host) {
        const now = Date.now();
        if (psCache && (now - psCacheTime) < CFG.PS_LOOKUP_CACHE_MS) return psCache;
        psCache = ns.ps(host);
        psCacheTime = now;
        return psCache;
    }

    // get how many threads of this script are running on this host (should be >=1)
    function getWorkerThreads(host) {
        const procs = getPs(host);
        for (const p of procs) {
            if (p.filename === SCRIPT_NAME) {
                return p.threads || 1;
            }
        }
        // fallback: if not found, return 1
        return 1;
    }

    // safe sleep wrapper
    async function sleep(ms) { if (ms > 0) await ns.sleep(ms); }

    log(`Starting worker on ${HOST}, target=${target}`);

    while (true) {
        try {
            // safety: ensure target exists
            if (!ns.serverExists(target)) {
                ns.tprint(`[worker:${HOST}] target ${target} unavailable -> exit`);
                return;
            }

            const minSec = ns.getServerMinSecurityLevel(target);
            const sec = ns.getServerSecurityLevel(target);
            const maxMoney = ns.getServerMaxMoney(target);
            const money = ns.getServerMoneyAvailable(target);

            // 1) PRIORITAS: weaken jika security terlalu tinggi
            if (sec > minSec + CFG.SEC_MARGIN) {
                log("weaken -> sec", sec.toFixed(3), "min", minSec.toFixed(3));
                await ns.weaken(target);
                // small pause then continue
                await sleep(100 + Math.floor(Math.random() * CFG.JITTER_MS));
                continue;
            }

            // 2) PRIORITAS: grow jika uang target kurang dari threshold
            if (money < maxMoney * CFG.GROW_PCT) {
                log("grow ->", Math.round(money), "/", Math.round(maxMoney));
                await ns.grow(target);
                await sleep(100 + Math.floor(Math.random() * CFG.JITTER_MS));
                continue;
            }

            // 3) READY TO HACK: use probabilistic distribution across worker threads
            // compute per-thread steal fraction and desired total hack threads
            const perThreadSteal = ns.hackAnalyze(target); // fraction stolen by one hack thread
            const hackChance = ns.hackAnalyzeChance(target);

            if (perThreadSteal <= 0 || hackChance <= 0) {
                // cannot hack right now, do a weaken to attempt to improve
                log("hackAnalyze or hackChance zero — doing weaken");
                await ns.weaken(target);
                await sleep(200 + Math.floor(Math.random() * CFG.JITTER_MS));
                continue;
            }

            // Do not hack if chance too low
            if (hackChance < CFG.MIN_HACK_CHANCE) {
                log("hack chance low", (hackChance*100).toFixed(1) + "% -> weaken");
                await ns.weaken(target);
                await sleep(200 + Math.floor(Math.random() * CFG.JITTER_MS));
                continue;
            }

            // Only hack when target has enough money (safety)
            if (money < maxMoney * CFG.HACK_SAFE_PCT) {
                log("money below safe pct, doing grow instead");
                await ns.grow(target);
                await sleep(200 + Math.floor(Math.random() * CFG.JITTER_MS));
                continue;
            }

            // Calculate how many threads (approx) should be hacking concurrently
            const threadsRunning = Math.max(1, getWorkerThreads(HOST));
            // desired total threads to achieve DESIRED_HACK_FRACTION
            const desiredTotalHackThreads = Math.max(1, Math.ceil(CFG.DESIRED_HACK_FRACTION / perThreadSteal));
            // probability that any given thread should perform hack right now
            let hackProb = Math.min(1, desiredTotalHackThreads / threadsRunning);

            // Slight tempering: if threadsRunning huge, limit hackProb to avoid spikes
            if (threadsRunning > 200) hackProb *= 0.9;

            // Decide probabilistically whether this thread hacks
            const roll = Math.random();
            if (roll < hackProb) {
                // perform hack
                log("hack (p=" + hackProb.toFixed(3) + ", roll=" + roll.toFixed(3) + ") -> money:",
                    Math.round(money), "/", Math.round(maxMoney));
                const start = Date.now();
                await ns.hack(target);
                const hackTime = ns.getHackTime(target);
                // after hack, sleep for hackTime +/- jitter to allow target to recover and avoid re-hacking immediately
                const postSleep = Math.max(200, Math.round(hackTime + (Math.random() - 0.5) * 0.5 * hackTime));
                await sleep(postSleep + Math.floor(Math.random() * 400));
            } else {
                // If not hacking, do a short maintenance action: either grow a bit or weaken a bit based on current state
                // Choose grow if money < 95% else small weaken if security slightly above min
                if (money < maxMoney * 0.97) {
                    log("idle -> small grow (not selected to hack)");
                    await ns.grow(target);
                } else if (sec > minSec + 0.5) {
                    log("idle -> small weaken (not selected to hack)");
                    await ns.weaken(target);
                } else {
                    // otherwise sleep a bit
                    log("idle -> sleeping (not selected to hack)");
                    await sleep(CFG.BASE_SLEEP_MS + Math.floor(Math.random() * CFG.JITTER_MS));
                }
            }

            // tiny pause between loops to avoid busy polling
            await sleep(50 + Math.floor(Math.random() * 150));
        } catch (e) {
            ns.tprint("[worker] error: " + String(e));
            await sleep(CFG.ERROR_SLEEP_MS);
        }
    }
}
