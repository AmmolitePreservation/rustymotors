// Ammolite's check of a login. With SITE_LOGIN_CHECK_SETTINGS set, AuthLogin asks the site whether the name and
// password a player gave are good (the player's site name with their site password, or with a login key the site gave
// the client Ankh started) and keeps no password of its own for it; without it AuthLogin checks the server's own logins.
import { readFileSync } from "node:fs";

export type SiteLoginCheckSettings = { checkUrl: string; token: string };
export type SiteLoginVerdict = { accountName: string } | { refusal: string };

const checkTimeoutMilliseconds = 15000;

let activeSettings: SiteLoginCheckSettings | undefined;

export function readSiteLoginCheckSettings(path: string): SiteLoginCheckSettings {
	const settings = JSON.parse(readFileSync(path, "utf8")) as Partial<SiteLoginCheckSettings>;
	const keys = Object.keys(settings).sort().join(",");
	if (keys !== "checkUrl,token") {
		throw new Error(`${path} must hold exactly checkUrl and token, not ${keys}`);
	}
	if (!/^https:\/\/\S+$/.test(settings.checkUrl ?? "")) {
		throw new Error(`${path}: checkUrl must be an https address`);
	}
	if (!/^[A-Za-z0-9_-]{32,}$/.test(settings.token ?? "")) {
		throw new Error(`${path}: token must be the login server's token the site issued`);
	}
	return settings as SiteLoginCheckSettings;
}

export function useSiteLoginCheck(settings: SiteLoginCheckSettings | undefined): void {
	activeSettings = settings;
}

export function siteLoginCheck(): SiteLoginCheckSettings | undefined {
	return activeSettings;
}

/**
 * Asks the site about a name and password a player gave from playerAddress. The site's own sentence comes back as the
 * refusal; it counts a wrong password toward the player's lockout. Throws when the site cannot be reached or answers
 * something else.
 */
export async function checkLoginWithSite(
	settings: SiteLoginCheckSettings,
	username: string,
	password: string,
	playerAddress: string,
): Promise<SiteLoginVerdict> {
	const response = await fetch(settings.checkUrl, {
		method: "POST",
		headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ username, password, playerAddress }),
		signal: AbortSignal.timeout(checkTimeoutMilliseconds),
	});
	const answer = (await response.json()) as { accountName?: unknown; error?: unknown };
	if (response.status === 200 && typeof answer.accountName === "string") {
		return { accountName: answer.accountName };
	}
	if (response.status !== 200 && typeof answer.error === "string") {
		return { refusal: answer.error };
	}
	throw new Error(`the site's login check answered HTTP ${response.status} without an account or a reason`);
}
