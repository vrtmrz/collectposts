import { NostrFetcher } from "npm:nostr-fetch";
import WebSocket from "npm:ws";

// This script fetches Nostr posts from specified relays and saves them to a CouchDB database.
// Use following .env variables:
// - FETCH_MINE_RELAYS: Comma-separated list of relay URLs to fetch posts from.
// - FETCH_MINE_AUTHORS: Comma-separated list of author public keys to filter posts (hex-format).
// - FETCH_MINE_DAYS_AGO: Number of days ago to start fetching posts from.
// - FETCH_MINE_DB_URI: CouchDB URI to save the posts.
// - FETCH_MINE_DB_AUTH: Basic authentication credentials for CouchDB (base64 encoded).
// The script fetches posts from the specified relays, filters them by author public keys,
// and saves them to the CouchDB database.


function stabiliseObjectProps<T>(obj: T): T {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) {
        return obj.sort().map((item) => {
            if (typeof item === "object" && item !== null) {
                return stabiliseObjectProps(item);
            }
            return item;
        }) as unknown as T;
    }
    const items = Object.entries(obj);
    const result = items.sort(([keyA], [keyB]) => {
        if (keyA < keyB) return -1;
        if (keyA > keyB) return 1;
        return 0;
    }).map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
            return [key, stabiliseObjectProps(value)];
        }
        return [key, value];
    });
    return Object.fromEntries(result) as T;
}

const fetcher = NostrFetcher.init({ webSocketConstructor: WebSocket });
const nDaysAgo = (days: number): number =>
    Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

const relayUrls = Deno.env.get("FETCH_MINE_RELAYS")?.split(",") ?? [
    "wss://relay.vrtmrz.net"];

const interested_pubkey = Deno.env.get("FETCH_MINE_AUTHORS")?.split(",") ?? [
    "ef8ad5874e10425b4aa924c44c55e303b7ebc51d4d76520bfce52c3171ec0ffe",
];
console.log(`Nostr post fetcher!`)
console.log(`--------------------------------`);
console.log(`started with relays: \n - ${relayUrls.join("\n - ")}\n`);
console.log(`Interested authors: \n - ${interested_pubkey.join("\n - ")}\n`);
const since = nDaysAgo(Number.parseInt(Deno.env.get("FETCH_MINE_DAYS_AGO") ?? "3"));
// const since = 0;

console.log(`Fetching since: ${new Date(since * 1000).toUTCString()}\n`);
// // fetches all text events since 24 hr ago, as a single array
const allPosts = await fetcher.fetchAllEvents(
    relayUrls,
    {
        authors: [
            ...interested_pubkey
        ],
    },
    { since: since },
    {
        withSeenOn: true,
    }
)

console.log(`Fetched ${allPosts.length} post(s) from ${relayUrls.length} relay(s)`);
fetcher.shutdown();

if (allPosts.length > 0) {
    console.log(`Saving ${allPosts.length} post(s) to CouchDB...`);
    const postData = allPosts.map((ev) => ({
        _id: ev.id,
        ...ev,
    }));
    const remote = Deno.env.get("FETCH_MINE_DB_URI");
    const BASIC = Deno.env.get("FETCH_MINE_DB_AUTH");
    const existent = await fetch(`${remote}/_all_docs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${BASIC}`,
        },
        body: JSON.stringify({
            keys: postData.map((item) => item.id),
            include_docs: true,
            limit: 100000000,
        }),
    });
    const existentResult = await existent.json();
    const existentDocs = Object.fromEntries(existentResult.rows.map((item: any) => [item.key, item?.doc ?? undefined]));
    const postReadyData = postData.map((item: any) => {
        if (existentDocs[item.id]) {
            const oldDoc = { ...existentDocs[item.id] };
            delete oldDoc._rev;
            // Do not care about seenOn is removed.
            const seenOnOld = oldDoc.seenOn ?? [];
            const seenOnItem = item.seenOn ?? [];
            const seenOn = [...new Set([...seenOnOld, ...seenOnItem])];
            oldDoc.seenOn = seenOnOld.sort();
            item.seenOn = seenOn.sort();
            if (JSON.stringify(stabiliseObjectProps(oldDoc)) === JSON.stringify(stabiliseObjectProps(item))) {
                return undefined;
            }
            item._rev = existentDocs[item.id]._rev;
            console.log(`Post ${item.id} have different data, updating`);
        }
        return item;
    }).filter((item: any) => item !== undefined);

    const result = await fetch(`${remote}_bulk_docs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${BASIC}`,
        },
        body: JSON.stringify({
            docs: postReadyData,
        }),
    });


    const jsonResult = await result.json();
    const succeed = jsonResult.filter((item: any) => item.ok);
    const duplicated = jsonResult.filter((item: any) => item.error == "conflict");

    console.log(`result code: ${result.status}`);

    console.log(`Total post for this fetch: ${jsonResult.length}`);
    console.log(`succeed: ${succeed.length}`);
    console.log(`duplicated: ${duplicated.length}`);
} else {
    console.log("No new posts found, nothing to do");
}
console.log(`Nostr post fetcher finished!`);
console.log(`--------------------------------`);