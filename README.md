# Secure Notes API

Backend for the Secure Note-Taking interview assessment: private notes, User/Admin permissions, public posts and two MongoDB aggregation views. The frontend is a separate repository: [care_guide_frontend](https://github.com/Tousifrahmananto/care_guide_frontend).

## Requirements and quick start

- **Node 26.12.1**, npm 11.20.0; the declared supported Node range is `>=26.12.1 <27`. Run `node --version` before installing. The project uses Node's environment-file flags and `import.meta.main` in its diagnostic scripts; older runtimes are not promised compatible.
- **MongoDB 9.0.x or 8.0.x, with a writable replica primary**. Tested: local 9.0.4 and Atlas 8.0.34. Standalone MongoDB is unsupported because account deletion and child creation use multi-document transactions.
- The local setup below uses Windows PowerShell and native MongoDB. Put the chosen Node and `mongod` executables on PATH.

For a new local clone, install dependencies and create the private configuration if absent:

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env`: retain the local URI below and set a private `JWT_SECRET` of at least 32 characters. Generate one using `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and store it only in the ignored file. Never commit real credentials.

### Start a local replica set

In one terminal, from the backend directory:

```powershell
New-Item -ItemType Directory -Force ../secure-notes-mongo-data | Out-Null
mongod --dbpath ../secure-notes-mongo-data --replSet notes-dev9 --bind_ip 127.0.0.1 --port 27029
```

Keep that process running. In a second terminal, from the backend directory, initialize it using the installed driver through Mongoose:

```powershell
@'
import mongoose from 'mongoose';
const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27029/admin', { directConnection: true });
try {
  await client.connect();
  try {
    await client.db('admin').command({ replSetInitiate: { _id: 'notes-dev9', members: [{ _id: 0, host: '127.0.0.1:27029' }] } });
  } catch (error) {
    if (error.code !== 23) throw error;
  }
  let hello;
  for (let attempt = 0; attempt < 60; attempt++) {
    hello = await client.db('admin').command({ hello: 1 });
    if (hello.setName === 'notes-dev9' && hello.isWritablePrimary) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (hello.setName !== 'notes-dev9' || !hello.isWritablePrimary) throw new Error('Replica primary not ready');
  console.log('Local notes-dev9 primary ready');
} finally { await client.close(); }
'@ | node --input-type=module
```

The initializer tolerates only MongoDB's already-initialized code `23`; it does not reconfigure an existing set. This single-member, loopback-only setup is for development, with no redundancy or database authentication. Use an appropriately secured replica set such as Atlas for hosting. If port 27029 already runs the correct set, reuse it instead of starting another process.

The local URI is:

```text
mongodb://127.0.0.1:27029/secure_notes_dev?replicaSet=notes-dev9
```

### Create indexes, seed and run

```powershell
npm run indexes
npm start
```

The API listens on port 3000 by default. `GET /api` is not an implemented endpoint and returns a structured 404; test public access using `GET http://localhost:3000/api/posts`. This backend does not serve the frontend.

To create the initial Admin and representative data, put explicit `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` values in an ignored `.env.seed` file. Passwords must contain at least 8 characters and at most 72 UTF-8 bytes. Then run:

```powershell
npm run seed
npm run explain
```

Both commands deliberately require `NODE_ENV=development` and database name `secure_notes_dev`. Use them only on a dedicated assessment development database. The seed creates an Admin, 60 sample users, 300 notes and 300 posts; it preserves existing credentials and edits on rerun and refuses to promote an existing ordinary account. There are no default Admin credentials. For this assessment's hosted database, prepare that dedicated database before switching the app to production; do not run development synchronization on a shared/live database.

The explain command is read-only and also works with an existing assessment dataset: it selects a saved note, its owner and a user with interests instead of requiring seed IDs. It requires the declared indexes, an existing note with its owner and at least one nonempty interest. Its filtered examples use that member's first two interests (the first is reused when there is only one), and its cursor example uses the same member's actual ID. These examples show the available data; they do not promise a rare-interest distribution. Do not rerun the seed just to inspect existing data.

## Configuration

| Variable | Meaning |
| --- | --- |
| `NODE_ENV` | `development`, `test` or `production`; defaults to development |
| `PORT` | HTTP port, default 3000 |
| `MONGODB_URI` | Private connection URI; development startup requires the dedicated name `secure_notes_dev` |
| `JWT_SECRET` | Private signing secret, at least 32 characters |
| `JWT_EXPIRES_IN` | Positive integer with `s`, `m`, `h` or `d`; default `1h` |
| `BCRYPT_COST` | Integer 4–31; default 12; test fixtures use 4 for speed |
| `FRONTEND_ORIGIN` | Exact frontend origin, such as `http://localhost:5500`; no trailing slash or path |
| `TRUST_PROXY_HOPS` | Nonnegative integer; default 0 for direct access; set only after verifying the actual proxy path |

For a fixed, enforced one-proxy deployment, use `TRUST_PROXY_HOPS=1`. The proxy must overwrite/append forwarding headers correctly, and the API must not have a shorter publicly reachable path. A wrong hop count can permit forged client addresses or combine all clients into one rate-limit bucket. Do not set unrestricted proxy trust. Authentication allows ten combined login/registration attempts per client IP per 15 minutes. Its in-memory store is for one process; use a shared store before adding instances.

## Index strategy: exactly four custom indexes

All definitions are `Schema.index()` calls in `src/models/`, with query-purpose comments. Model `autoIndex` and `autoCreate` remain disabled.

| Model | Custom index | Exact query served |
| --- | --- | --- |
| User | `{ email: 1 }`, unique | Normalized login lookup and database-enforced email uniqueness |
| User | `{ interests: 1 }`, multikey | Interest membership filtering and equality member lookups |
| Note | `{ ownerId: 1, _id: -1 }` | Own/Admin owner-filtered notes in descending ID order; owner-prefix counts and cascade cleanup |
| Post | `{ authorId: 1, _id: -1 }` | Author-post lookup in descending ID order; author-prefix cleanup |

Each collection already has an automatic `_id_` index. It supports profile/detail reads and unfiltered ID-ordered lists. Compound prefixes cover owner/author-only filters, so adding separate ownerId/authorId indexes would be redundant. There are no role, timestamp, title or content indexes.

Unfiltered user, note and post list totals use `countDocuments({}).hint('_id_')` to count existing index keys without fetching every document. Owner-filtered note counts retain the owner-prefix access path. Counts remain exact and O(N) in matching index entries; the hint creates no index and does not turn counting into constant-time work.

`npm run indexes` awaits `createIndexes()` in every environment and never reconciles/drops existing indexes. Production/test startup also awaits that same helper before listening. Existing matching indexes are retained, not rebuilt on every start. Duplicate existing emails, conflicting definitions or missing permissions cause failure; inspect and resolve the data/configuration deliberately rather than deleting records automatically.

Only development startup uses `syncIndexes()`, guarded by the actual database name `secure_notes_dev`. It can drop indexes not declared in the schemas. Do not use that development path on shared data. Production permits other database names and does not call `syncIndexes()`.

### Measured explain evidence

`npm run explain` runs the same pipeline builders as the API and reports real execution statistics, index lists and raw plans for 17 read/count/aggregation cases. Example local 9.0.4 evidence on 61 users, 300 notes and 300 posts:

| Query | Executed index | Documents / keys examined |
| --- | --- | --- |
| Normalized email | `email_1` | 1 / 1 |
| User detail | `_id_` | 1 / 1 |
| Own/owner-filtered notes | `ownerId_1__id_-1` | 5 / 5 |
| Unfiltered first user/note/post page | `_id_` | 20 / 20 |
| Author posts, foreign lookup | `authorId_1__id_-1` | 5 / 5; zero foreign collection scans |
| Owner-note count | compound owner prefix | 0 / 5 |
| Exact global user/note/post counts | `_id_` hint | 0 documents; all matching index keys scanned |

These are representative measurements, not production latency guarantees. Global interest grouping must process all memberships; its input scan and grouped-name sort are expected. Exact global counts scan index keys using the existing `_id_` hint. Member lookup plans vary with cardinality and may use `_id_` to walk descending IDs while filtering interest. These observations do not justify a speculative fifth index. Large offsets and exact totals should be measured again if the workload grows.

## Routes and behavior

Base path `/api`. Responses use `{ data }`, paginated `{ data, page, limit, total, totalPages }`, or `{ error: { message } }`; login returns `{ token }` and successful deletion returns 204.

| Routes | Access |
| --- | --- |
| `POST /auth/register`, `POST /auth/login` | Public; registration always creates role `user` |
| `GET /me`, `PATCH /me` | Signed in; profile updates only name/interests |
| `POST /notes`, `GET /notes` | Signed in; own notes |
| `GET /notes/:id` | Owner or Admin |
| `PATCH /notes/:id`, `DELETE /notes/:id` | Owner only |
| `GET /admin/notes` | Admin; optional `ownerId` filter |
| `POST /admin/users`, `GET /admin/users` | Admin |
| `GET /admin/users/:id`, `PATCH /admin/users/:id`, `DELETE /admin/users/:id` | Admin; self-delete/demotion prohibited |
| `GET /admin/users/by-interest` | Admin; one view aggregation |
| `POST /posts` | Signed in; author derived from current user |
| `GET /posts`, `GET /posts/by-user/:userId` | Public; author view uses one pipeline and exactly one lookup |

Every list defaults to 20 and caps the requested limit at 100. Invalid/repeated/nested pagination inputs return 400. Interest groups have group pagination and independent member cursors (`interest`, `memberLimit`, `afterUserId`); no user is permanently cut off by a member window. Authentication reloads the current user separately from the aggregation view query, so deletion and role changes take effect on subsequent requests.

### Making authenticated requests

After registering an account or creating the initial Admin, log in and attach the token to protected requests. Replace the example credentials with your account's values:

```powershell
$api = 'http://localhost:3000/api'
$credentials = @{ email = 'your-account@example.com'; password = 'your-password' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType 'application/json' -Body $credentials
$auth = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri "$api/me" -Headers $auth
$note = @{ title = 'First note'; content = 'Private note content' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/notes" -Headers $auth -ContentType 'application/json' -Body $note
Invoke-RestMethod -Uri "$api/notes?page=1&limit=20" -Headers $auth
```

Account inputs normalize email and interests by trimming/lowercasing, remove blank/duplicate interests and accept at most 20 interests of 100 UTF-16 units each. Passwords are not trimmed or normalized. Note/post titles have a 200-unit maximum and content a 10,000-unit maximum; a note may have empty content, while a post requires content. JSON bodies are limited to 100kb.

### Aggregation views

`GET /api/admin/users/by-interest?page=1&limit=20&memberLimit=20` pages interest groups. Each group contains `interest`, `count`, safe `users`, `hasMoreUsers` and `nextUserCursor`. To continue one group's members, send its interest and cursor as `interest=chess&afterUserId=<nextUserCursor>&memberLimit=20`; encode interest values when constructing URLs. The cursor changes the member page, not the total membership count. The view performs exactly one aggregation call and no additional view query methods.

`GET /api/posts/by-user/<userId>?page=1&limit=20` returns public posts and a safe author object using one aggregation pipeline with one `$lookup`. An existing author with no posts returns an empty page; an unknown author returns 404. Public output excludes email, hashes, internal version counters and private notes.

| Status | Meaning |
| --- | --- |
| `400` | Malformed JSON, invalid fields, ID, cursor or pagination |
| `401` | Missing, invalid or expired authentication, including a deleted account |
| `403` | Current role cannot perform the operation, or the supplied Origin is not allowed |
| `404` | Missing resource; another user's private note also returns 404 |
| `409` | Duplicate email or prohibited self-deletion/demotion |
| `413` | Request body exceeds the JSON size limit |
| `429` | Authentication attempt limit reached |
| `500` | Unexpected server failure; internal details are not returned |

Deleting a user removes that user's notes/posts atomically. Child creation and deletion write the same User inside transactions so a concurrent create cannot leave an orphan. Admin mutations coordinate current actor and target in consistent ID order, preventing stale authorization and conflicting actions from leaving no Admin. Password hashes never appear in API responses; unexpected server errors keep generic public messages and log only method, static route, status and error category/code.

## Verify

Run the full suite against the dedicated **local** test database, never Atlas:

```powershell
$env:TEST_MONGODB_URI='mongodb://127.0.0.1:27029/secure_notes_models_test?replicaSet=notes-dev9'
npm test
```

Without `TEST_MONGODB_URI`, database suites are explicitly skipped. A green partial run does not verify transactions, actual indexes or aggregation plans. Integration tests reject a non-loopback/wrong base database URI; temporary production-startup/index test databases are uniquely named and guarded before cleanup.

The `/tests` ignore rule applies to new, untracked test files. Previously committed tests remain versioned. Additional local regressions, including the CORS test, may be absent from a fresh clone; a local suite count should not be assumed to match the committed suite.

## Hosting and deployment

| Resource | Address |
| --- | --- |
| Backend repository | [care_guide_backend](https://github.com/Tousifrahmananto/care_guide_backend) |
| Frontend repository | [care_guide_frontend](https://github.com/Tousifrahmananto/care_guide_frontend) |
| Frontend, Vercel | [care-guide-notes.vercel.app](https://care-guide-notes.vercel.app) |
| Backend API, Render | [Public posts](https://care-guide-notes-api.onrender.com/api/posts), base `https://care-guide-notes-api.onrender.com/api` |

Both services are publicly available over HTTPS. Hosted integration checks cover authentication, note CRUD and ownership, Admin permissions, public posts, author lookup, interest-member pagination, CORS and browser sessions.

The Render web service `care-guide-notes-api` uses the `main` branch, Singapore region and Free instance. Build with `npm ci --omit=dev` and start with `npm start`. Set `NODE_VERSION=26.12.1`, `NODE_ENV=production`, private `MONGODB_URI` and `JWT_SECRET`, `JWT_EXPIRES_IN=1h`, `BCRYPT_COST=12`, and `FRONTEND_ORIGIN=https://care-guide-notes.vercel.app`. Render supplies `PORT`; the app binds to that port. Store secrets only in Render's environment configuration, never this repository or the frontend.

`TRUST_PROXY_HOPS=3` is configured for the current Render ingress path. Live checks matched the limiter's client identity to the actual outbound client address and preserved that identity with forged single- and multi-address forwarding headers. Recheck this setting after adding a custom domain or another proxy; a different path can require different trust. Incorrect proxy trust can combine rate-limit buckets or accept forged client addresses. The in-memory authentication limiter supports one API instance.

Atlas must permit the service's outbound ranges. Read the current values from Render's **Connect** menu; this service currently lists `74.220.52.0/24` and `74.220.60.0/24`. Preserve existing required Atlas entries. These ranges are shared by Render services, so database credentials and least-privilege database access remain necessary. A successful local connection does not prove the hosted service is allowed to connect.

Production startup awaits the four declared custom indexes using `createIndexes()` before accepting requests. It never runs development index synchronization. Keep MongoDB's replica-set requirement and database permissions in place; do not weaken the connection or index checks to hide a hosting failure.

Render's free instance spins down with inactivity and can delay requests by 50 seconds or more. Verify HTTPS, CORS/preflights, proxy headers, the deployed four-index budget, registration/login, ownership, Admin views and public aggregation reads on the hosted service. `GET /api` still returns 404 by design; use `GET /api/posts` for a public API check. The frontend's `config.js` targets the HTTPS API above.

References: [Mongoose index API](https://mongoosejs.com/docs/api/model.html#Model.createIndexes()), [Express proxy trust](https://expressjs.com/en/guide/behind-proxies.html), [MongoDB development replica sets](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-for-testing/), [transaction restrictions](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).
