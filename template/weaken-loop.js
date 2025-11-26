/** weaken-loop.js
 * Weaken-only daemon. Run with: run weaken-loop.js <target>
 * Use many threads: ns.exec("weaken-loop.js", server, threads, target)
 */

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run weaken-loop.js <target>");
        return;
    }

    const CFG = {
        POST_SLEEP_MS: 50,
        LOG_EVERY: 0, // set >0 to print every N loops
    };

    let loop = 0;
    while (true) {
        try {
            if (!ns.serverExists(target)) {
                ns.tprint(`weaken-loop: target ${target} not found -> exit`);
                return;
            }
            await ns.weaken(target);
            loop++;
            if (CFG.LOG_EVERY > 0 && loop % CFG.LOG_EVERY === 0) {
                ns.tprint(`weaken-loop ${target} iteration ${loop}`);
            }
            await ns.sleep(CFG.POST_SLEEP_MS);
        } catch (e) {
            ns.tprint("weaken-loop error: " + String(e));
            await ns.sleep(2000);
        }
    }
}
