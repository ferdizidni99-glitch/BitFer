/** tiny-worker.js
 * General-purpose small worker for low-RAM hosts.
 * Usage: run tiny-worker.js <target> [--verbose]
 *
 * Behavior:
 *  - Prioritizes weaken -> grow -> hack
 *  - Small sleeps and jitter to reduce synchronization
 */

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    const args = ns.args;
    const target = String(args[0] || "");
    const VERBOSE = args.includes("--verbose");

    if (!target) {
        ns.tprint("Usage: run tiny-worker.js <target> [--verbose]");
        return;
    }

    const log = (...m) => { if (VERBOSE) ns.tprint("[tiny] " + m.join(" ")); };

    const CFG = {
        SEC_MARGIN: 2,
        GROW_PCT: 0.85,
        BASE_SLEEP_MS: 50,
        JITTER_MS: 300
    };

    log("starting tiny-worker on", target);
    while (true) {
        try {
            if (!ns.serverExists(target)) {
                ns.tprint("tiny-worker: target missing -> exit");
                return;
            }

            const sec = ns.getServerSecurityLevel(target);
            const minSec = ns.getServerMinSecurityLevel(target);
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);

            if (sec > minSec + CFG.SEC_MARGIN) {
                log("weaken (sec high)", sec.toFixed(2));
                await ns.weaken(target);
            } else if (money < maxMoney * CFG.GROW_PCT) {
                log("grow (money low)", Math.round(money), "/", Math.round(maxMoney));
                await ns.grow(target);
            } else {
                // before hacking check chance
                const chance = ns.hackAnalyzeChance(target);
                if (chance <= 0.10) {
                    log("chance low -> weaken");
                    await ns.weaken(target);
                } else {
                    log("hack (chance)", (chance*100).toFixed(1) + "%");
                    await ns.hack(target);
                }
            }

            const jitter = Math.floor(Math.random() * CFG.JITTER_MS);
            await ns.sleep(CFG.BASE_SLEEP_MS + jitter);
        } catch (e) {
            ns.tprint("tiny-worker error: " + String(e));
            await ns.sleep(2000);
        }
    }
}
