// index.js
require('dotenv').config();
const fetch = require('node-fetch');

// Get webhook from environment variable
const webhookUrl = process.env.discordwebhook;
if (!webhookUrl) {
    console.error("Error: discordwebhook environment variable not set!");
    process.exit(1);
}

// Configurable number of concurrent requests
const MAX_CONCURRENT = 5;

// Generate a random Roblox group ID
function randomGroupId() {
    return Math.floor(Math.random() * (999999999 - 9999999 + 1)) + 9999999;
}

// Check a group
async function checkGroup() {
    const id = randomGroupId();

    try {
        // Step 1: Check the legacy group page (not strictly needed)
        const r = await fetch(`https://www.roblox.com/groups/group.aspx?gid=${id}`);
        const rText = await r.text();
        if (rText.includes('owned')) {
            console.log(`[-] Group Already Owned: ${id}`);
            return;
        }

        // Step 2: Use Roblox API to get group info
        const re = await fetch(`https://groups.roblox.com/v1/groups/${id}`);
        const reJson = await re.json();

        if (!('isLocked' in reJson) && 'owner' in reJson) {
            if (reJson.publicEntryAllowed === true && reJson.owner === null) {
                // Send to Discord webhook
                await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: `Hit: https://www.roblox.com/groups/group.aspx?gid=${id}` })
                });
                console.log(`[+] Hit: ${id}`);
            } else {
                console.log(`[-] No Entry Allowed: ${id}`);
            }
        } else {
            console.log(`[-] Group Locked: ${id}`);
        }
    } catch (err) {
        console.error(`Error checking group ${id}:`, err.message);
    }
}

// Loop with concurrency
async function run() {
    while (true) {
        const tasks = [];
        for (let i = 0; i < MAX_CONCURRENT; i++) {
            tasks.push(checkGroup());
        }
        await Promise.all(tasks);
    }
}

// Start
console.log(`
____ _    ____ _  _ ____    ____ ____ ____ _  _ ___  
|__| |    |___ |_/  [__     | __ |__/ |  | |  | |__] 
|  | |___ |___ | \\_ ___]    |__] |  \\ |__| |__| |    

____ _ _  _ ___  ____ ____ 
|___ | |\\ | |  \\ |___ |__/ 
|    | | \\| |__/ |___ |  \\ 
`);

run();
