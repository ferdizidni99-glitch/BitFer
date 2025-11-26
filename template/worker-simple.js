/** worker-simple.js
 * Ultra-small worker for tiny hosts (2-8GB).
 * Usage: run worker-simple.js <target>
 * Minimal RAM usage. Performs simple weaken/grow/hack loop.
 */

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run worker-simple.js <target>");
        return;
    }

    const CFG = { SEC_MARGIN: 3, GROW_PCT: 0.80, SLEEP_MS: 100 };

    while (true) {
        try {
            const sec = ns.getServerSecurityLevel(target);
            const minSec = ns.getServerMinSecurityLevel(target);
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);

            if (sec > minSec + CFG.SEC_MARGIN) {
                await ns.weaken(target);
            } else if (money < maxMoney * CFG.GROW_PCT) {
                await ns.grow(target);
            } else {
                await ns.hack(target);
            }

            await ns.sleep(CFG.SLEEP_MS);
        } catch (e) {
            ns.tprint("worker-simple error: " + String(e));
            await ns.sleep(5000);
        }
    }
}
