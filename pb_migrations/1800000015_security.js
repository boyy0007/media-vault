/// <reference path="../pb_data/types.d.ts" />
// Hardening.
//
// Rate limits (PocketBase's own limiter, per client address): guessing passwords, invite codes and reset requests
// is slowed to a crawl. Everything arriving through `tailscale serve` comes from 127.0.0.1 and shares one count, so
// the limits are sized for a household signing in, not one person: and turning the limiter on also turns on
// PocketBase's defaults (e.g. 300 API requests per 10 s), which a page of thumbnails would trip, so those labels are
// replaced here. Other rules someone added in the dashboard are kept.
//
// users.allowPublic  may make public (internet) share links; the owner always may. Set by the owner on the People
//                    screen (/api/library/people); users can't set it themselves. Checked in checkAudience()
//                    (pb_hooks/share_lib.js).

const RULES = [
  { label: "*:authWithPassword", audience: "", duration: 60, maxRequests: 10 },
  { label: "*:requestPasswordReset", audience: "", duration: 60, maxRequests: 5 },
  { label: "users:create", audience: "", duration: 60, maxRequests: 10 }, // sign-ups, i.e. invite-code guesses
  { label: "*:auth", audience: "", duration: 60, maxRequests: 60 },
  { label: "*:create", audience: "", duration: 10, maxRequests: 200 }, // uploads of a whole folder
  { label: "/api/batch", audience: "", duration: 1, maxRequests: 3 },
  { label: "/api/", audience: "", duration: 60, maxRequests: 6000 }, // a safety net only
];
const NO_SELF = "@request.body.allowPublic:isset = false";
const add = (rule, extra) => {
  const r = String(rule ?? "").trim();
  return r ? `${r} && ${extra}` : extra;
};
const strip = (rule, extra) => String(rule ?? "").replace(` && ${extra}`, "").replace(extra, "");

migrate((app) => {
  const s = app.settings();
  const ours = RULES.map((r) => r.label);
  s.rateLimits.rules = [...s.rateLimits.rules.filter((r) => !ours.includes(r.label)), ...RULES];
  s.rateLimits.enabled = true;
  app.save(s);

  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new BoolField({ name: "allowPublic" }));
  if (users.createRule !== null) users.createRule = add(users.createRule, NO_SELF);
  if (users.updateRule !== null) users.updateRule = add(users.updateRule, NO_SELF);
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("allowPublic");
  if (users.createRule !== null) users.createRule = strip(users.createRule, NO_SELF);
  if (users.updateRule !== null) users.updateRule = strip(users.updateRule, NO_SELF);
  app.save(users);
  // (The rate limits stay on: turning protection off is left to the dashboard.)
});
