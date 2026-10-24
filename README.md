# Secure Notes API

REST API for a note-taking application, built with Express, MongoDB and Mongoose. Users manage their own private notes. Admins also manage accounts and read everyone's notes. The aggregation views group users by interest and retrieve one author's public posts.

| Resource | Link |
| --- | --- |
| Live API | [Public posts](https://care-guide-notes-api.onrender.com/api/posts) |
| Live frontend | [care-guide-notes.vercel.app](https://care-guide-notes.vercel.app) |
| Backend repository | [care_guide_backend](https://github.com/Tousifrahmananto/care_guide_backend) |
| Frontend repository | [care_guide_frontend](https://github.com/Tousifrahmananto/care_guide_frontend) |

The API base is `https://care-guide-notes-api.onrender.com/api`. Open the public posts link above to check the service. `GET /api` returns 404 because the base path has no handler; the backend does not serve the frontend. Render's free instance can take about a minute to wake after inactivity.

## Requirements

- Node 26.12.1 and npm 11.20.0. The supported Node range is `>=26.12.1 <27`. Check `node --version` before installing dependencies. The scripts use Node's environment-file flags and `import.meta.main`.
- MongoDB 8.0.x or 9.0.x with a writable replica primary. The application has been tested with Atlas 8.0.34 and local MongoDB 9.0.4. Account deletion and note/post creation use transactions, so a standalone MongoDB server is unsupported.
- A separate frontend. This repository contains the API only.

## Run locally

The commands below use Windows PowerShell. Run them from the backend directory with Node and `mongod` on PATH.

### Install and configure

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env` and set `JWT_SECRET` to a private value of at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Store it in the ignored file and keep real credentials out of Git.

| Variable | Value or purpose |
| --- | --- |
| `NODE_ENV` | `development`, `test` or `production`; defaults to development |
| `PORT` | HTTP port; defaults to 3000 |
| `MONGODB_URI` | Connection URI; development startup requires the database name `secure_notes_dev` |
| `JWT_SECRET` | Private JWT signing secret, at least 32 characters |
| `JWT_EXPIRES_IN` | Positive integer followed by `s`, `m`, `h` or `d`; defaults to `1h` |
| `BCRYPT_COST` | Integer from 4 to 31; defaults to 12. Tests use 4 to reduce hashing time. |
| `FRONTEND_ORIGIN` | Exact frontend origin, such as `http://localhost:5500`, without a path or trailing slash |
| `TRUST_PROXY_HOPS` | Number of trusted proxy hops; defaults to 0 for direct local access |

### Start MongoDB

Start a local replica set in one terminal:

```powershell
New-Item -ItemType Directory -Force ../secure-notes-mongo-data | Out-Null
mongod --dbpath ../secure-notes-mongo-data --replSet notes-dev9 --bind_ip 127.0.0.1 --port 27029
```

Keep it running. In a second terminal, initialize the replica set through the driver included with Mongoose:

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

The initializer accepts MongoDB's already-initialized code `23` and leaves the existing replica configuration in place. Reuse the process if port 27029 already runs the correct set.

Use this URI in `.env`:

```text
mongodb://127.0.0.1:27029/secure_notes_dev?replicaSet=notes-dev9
```

This single-member setup binds to loopback and has no database authentication or redundancy. It is intended for local development. Use a secured replica set, such as Atlas, for hosting.

### Start the API

```powershell
npm run indexes
npm start
```

The default address is `http://localhost:3000/api`. Check `GET http://localhost:3000/api/posts` for a public response. Requests for private notes and Admin views require a token.

### Create the first Admin and sample data

Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in an ignored `.env.seed` file. Passwords must contain at least 8 characters and fit within 72 UTF-8 bytes. In another terminal, run:

```powershell
npm run seed
npm run explain
```

The seed creates an Admin, 60 sample users, 300 notes and 300 posts. Reruns preserve existing credentials and edits. The script refuses to promote an existing ordinary account to Admin, and there are no default Admin credentials.

Both commands require `NODE_ENV=development` and database name `secure_notes_dev`. Use a dedicated development database. Prepare sample data there before switching the hosted application to production; development index synchronization must not run against shared or live data.

The explain command only reads data. It selects an existing note, its owner and a user with interests, so it also works on a dataset created without the sample seed. It needs those records and the declared indexes to exist. Its filtered examples use the selected member's first two interests, or reuse the first when there is only one. The cursor example uses that member's actual ID. The second interest is a sample of available data, with no assumption about rarity. Reseeding is unnecessary when those records already exist.

## Permissions and endpoints

All routes below are relative to `/api`.

| Routes | Access and behavior |
| --- | --- |
| `POST /auth/register`, `POST /auth/login` | Public; registration always creates role `user` |
| `GET /me`, `PATCH /me` | Signed in; profile updates accept only name and interests |
| `POST /notes`, `GET /notes` | Signed in; create or list own notes |
| `GET /notes/:id` | Note owner or Admin |
| `PATCH /notes/:id`, `DELETE /notes/:id` | Note owner only, including when the requester is an Admin |
| `GET /admin/notes` | Admin; all notes or an optional `ownerId` filter |
| `POST /admin/users`, `GET /admin/users` | Admin; create or list accounts |
| `GET /admin/users/:id`, `PATCH /admin/users/:id`, `DELETE /admin/users/:id` | Admin; self-deletion and self-demotion are prohibited |
| `GET /admin/users/by-interest` | Admin; grouped interest view in one aggregation |
| `POST /posts` | Signed in; author comes from the current account |
| `GET /posts`, `GET /posts/by-user/:userId` | Public; the author view uses one pipeline with one lookup |

Admins can create and manage their own notes through the same routes as other users. They can read another user's notes, while updates and deletion remain limited to the owner. Ownership is part of each private-note query, and role checks run in middleware.

### Requests and responses

Log in and attach the returned token to protected requests. Replace the example credentials with your own account:

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

Single-resource responses use `{ data }`. Lists use `{ data, page, limit, total, totalPages }`; errors use `{ error: { message } }`. Login returns `{ token }`, and successful deletion returns 204 without a body.

Every list defaults to 20 items and caps the requested limit at 100. Invalid, repeated or nested pagination inputs return 400. Interest groups have a separate member limit and cursor through `interest`, `memberLimit` and `afterUserId`, so members beyond the first page remain reachable.

Email and interests are trimmed and lowercased. Blank and duplicate interests are removed, with at most 20 interests of 100 UTF-16 units each. Passwords retain their original whitespace and case. Note/post titles allow up to 200 units and content up to 10,000 units. Notes may have empty content; posts require content. JSON bodies are limited to 100kb.

| Status | Meaning |
| --- | --- |
| `400` | Malformed JSON or invalid fields, ID, cursor or pagination |
| `401` | Missing, invalid or expired authentication, including a deleted account |
| `403` | Current role lacks access, or the supplied Origin is not allowed |
| `404` | Missing resource; another user's private note also returns this status |
| `409` | Duplicate email or prohibited self-deletion/demotion |
| `413` | Request body exceeds the JSON size limit |
| `429` | Authentication attempt limit reached |
| `500` | Unexpected server failure; internal details stay out of the response |

### Authentication and account deletion

Passwords are hashed with bcrypt. Password hashes never appear in API responses. Authentication reloads the current account, so deletion and role changes take effect on subsequent requests. The authentication lookup is separate from the aggregation used to build a view.

Deleting an account removes its notes and posts in the same transaction. Child creation and deletion both write the parent User document, so a concurrent create cannot leave an orphan. Admin changes coordinate the acting account and target in consistent ID order. This prevents stale authorization and opposing Admin actions from removing every Admin.

Unexpected errors return a generic public message. Server diagnostics record the method, static route, status and error category/code without logging raw request bodies, tokens or connection strings.

## Aggregation views

### Users grouped by interest

`GET /api/admin/users/by-interest?page=1&limit=20&memberLimit=20` returns paginated groups. Each group contains `interest`, `count`, safe `users`, `hasMoreUsers` and `nextUserCursor`.

Continue one group's members with `interest=chess&afterUserId=<nextUserCursor>&memberLimit=20`. Encode interest values when constructing the URL. The cursor changes the member page and leaves the full membership count intact. Group totals and member pages are built in exactly one aggregation call, with no additional view query methods.

### Posts by one user

`GET /api/posts/by-user/<userId>?page=1&limit=20` returns public posts and a safe author object through one pipeline with one `$lookup`. An existing author without posts returns an empty page. An unknown author returns 404. The response excludes email, password hashes, internal version counters and private notes.

## Index strategy

The models declare exactly four custom indexes using `Schema.index()` in `src/models/`. Each declaration has a comment naming the query it supports. Model `autoIndex` and `autoCreate` are disabled.

| Model | Custom index | Query served |
| --- | --- | --- |
| User | `{ email: 1 }`, unique | Normalized login and database-enforced email uniqueness |
| User | `{ interests: 1 }`, multikey | Interest filtering and equality lookups for group members |
| Note | `{ ownerId: 1, _id: -1 }` | Own/Admin owner-filtered notes in descending ID order; owner-prefix counts and cascade cleanup |
| Post | `{ authorId: 1, _id: -1 }` | Author-post lookup in descending ID order; author-prefix cleanup |

The automatic `_id_` indexes cover profile/detail reads and unfiltered lists ordered by ID. The owner and author compound prefixes also cover filters on those fields alone. Separate ownerId/authorId indexes would duplicate that coverage. The models have no role, timestamp, title or content indexes.

Unfiltered user, note and post totals use `countDocuments({}).hint('_id_')` to count keys without fetching every document. Owner-filtered note totals use the existing compound prefix. Exact totals remain O(N) in matching index entries.

### Creating indexes

`npm run indexes` awaits `createIndexes()` in every environment. Production and test startup use the same helper before accepting requests. It retains matching indexes and never reconciles or drops existing indexes. Duplicate emails, conflicting definitions or missing permissions cause startup to fail so the underlying data or configuration can be corrected.

Development startup uses `syncIndexes()` only when the actual database name is `secure_notes_dev`. It can drop indexes absent from the schemas and must remain confined to that dedicated database. Production accepts other database names and does not use this synchronization path.

### Reading explain output

`npm run explain` uses the same aggregation builders as the API. It reports execution statistics, index lists and raw plans for 17 read/count/aggregation cases. Representative local MongoDB 9.0.4 measurements on 61 users, 300 notes and 300 posts:

| Query | Executed index | Documents / keys examined |
| --- | --- | --- |
| Normalized email | `email_1` | 1 / 1 |
| User detail | `_id_` | 1 / 1 |
| Own/owner-filtered notes | `ownerId_1__id_-1` | 5 / 5 |
| Unfiltered first user/note/post page | `_id_` | 20 / 20 |
| Author posts, foreign lookup | `authorId_1__id_-1` | 5 / 5; zero foreign collection scans |
| Owner-note count | compound owner prefix | 0 / 5 |
| Exact global user/note/post counts | `_id_` hint | 0 documents; all matching index keys scanned |

These figures describe database work on that dataset. They are not latency guarantees. Global interest grouping must process all memberships and sort the resulting group names. Member lookup plans depend on data distribution and may walk `_id_` in descending order while filtering interest. Exact totals and deep offset pages still grow more expensive with more data; those costs need measurement before changing the index plan.

## Tests

Run database tests against the dedicated local replica, never Atlas:

```powershell
$env:TEST_MONGODB_URI='mongodb://127.0.0.1:27029/secure_notes_models_test?replicaSet=notes-dev9'
npm test
```

Without `TEST_MONGODB_URI`, database suites are skipped. Such a run does not verify transactions, stored indexes or aggregation plans. Integration tests check the loopback host and expected base database name before connecting. Temporary databases used for production-startup/index checks have unique names and guarded cleanup.

The `/tests` ignore rule applies to new, untracked files. Previously committed tests remain versioned. Local-only regressions, including the CORS test, may be absent from a fresh clone, so test counts can differ between the local checkout and the repository.

## Deployment

The frontend runs on Vercel and this API runs on Render over HTTPS. The Render service `care-guide-notes-api` deploys from `main` in Singapore on a Free instance. Its build command is `npm ci --omit=dev` and start command is `npm start`.

Set `NODE_VERSION=26.12.1`, `NODE_ENV=production`, private `MONGODB_URI` and `JWT_SECRET`, `JWT_EXPIRES_IN=1h`, `BCRYPT_COST=12` and `FRONTEND_ORIGIN=https://care-guide-notes.vercel.app`. Render supplies `PORT`. Keep secrets in the backend environment configuration; frontend files are public.

### Proxy trust and rate limits

Use `TRUST_PROXY_HOPS=0` for direct local access. A fixed, enforced one-proxy deployment can use `TRUST_PROXY_HOPS=1` if the proxy handles forwarding headers correctly and there is no shorter public path to the API. The current Render ingress uses `TRUST_PROXY_HOPS=3`, verified against the actual client address with single- and multi-address forged forwarding headers. Check it again after adding a domain or another proxy.

Unrestricted or incorrect proxy trust can accept forged addresses or combine clients into one rate-limit bucket. Authentication allows ten combined login/registration attempts per client IP per 15 minutes. The in-memory limiter supports one process; use a shared store before adding instances.

### Database access and hosting checks

Atlas must allow the backend's outbound ranges. Read them from Render's Connect menu; the current service lists `74.220.52.0/24` and `74.220.60.0/24`. Preserve other required Atlas entries. These ranges are shared, so database credentials and least-privilege access still matter. Check connectivity from the hosted service as well as the local machine.

Production startup waits for the four declared custom indexes through `createIndexes()` before accepting requests. Keep the replica-set requirement and database permissions in place when diagnosing a hosting failure.

After a deployment or configuration change, check HTTPS, CORS/preflights, proxy headers, the four-index inventory, registration/login, note CRUD and ownership, Admin views, public posts, aggregation views and browser sessions. The frontend's `config.js` points to the HTTPS API base listed above. A slow first request after inactivity can be Render waking its free instance; requests may take 50 seconds or more during that wake-up.

References: [Mongoose index API](https://mongoosejs.com/docs/api/model.html#Model.createIndexes()), [Express proxy trust](https://expressjs.com/en/guide/behind-proxies.html), [MongoDB development replica sets](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-for-testing/), [transaction restrictions](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).
