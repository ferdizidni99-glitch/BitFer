/** grow-loop.js
 * Grow-only daemon. Run with: run grow-loop.js <target>
 * Use many threads: ns.exec("grow-loop.js", server, threads, target)
 */

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run grow-loop.js <target>");
        return;
    }

    const CFG = {
        POST_SLEEP_MS: 60,
        LOG_EVERY: 0,
    };

    let loop = 0;
    while (true) {
        try {
            if (!ns.serverExists(target)) {
                ns.tprint(`grow-loop: target ${target} not found -> exit`);
                return;
            }
            await ns.grow(target);
            loop++;
            if (CFG.LOG_EVERY > 0 && loop % CFG.LOG_EVERY === 0) {
                ns.tprint(`grow-loop ${target} iteration ${loop}`);
            }
            await ns.sleep(CFG.POST_SLEEP_MS);
        } catch (e) {
            ns.tprint("grow-loop error: " + String(e));
            await ns.sleep(2000);
        }
    }
}
