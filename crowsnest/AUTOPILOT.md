# Crow's Nest background autopilot: playbook

This file is the instruction set for a **scheduled Claude session** that runs one Crow's Nest check-in
against the owner's live, agentic Robinhood account while the web page is closed. It runs the same
desk cycle as the page (Scout + Analyst → Head Honcho → Operator → risk gate) through
`bin/autopilot.mjs`, and writes the results back to the page's database so the owner sees them on the
Desk, AI Desk and Planner tabs.

The scheduled task's prompt gives you the **artifact URL** (the Crow's Nest page). Everything else is
below.

## Hard rules

1. Only send orders listed in `out/outbox.json` from this run. Do not change a symbol, side, quantity,
   price or contract. The one edit allowed is replacing an option leg's OCC symbol with its Robinhood
   instrument id (step 6a).
2. Always call the order's `review_tool` before its `place_tool`. If the review returns any
   `order_checks` alert, do **not** place it: record `needs_review` with the alert text verbatim.
3. For an **opening** order (`opening: true`) with a `refPrice`: if the live Robinhood price has moved
   more than 1.5% against it since the cycle priced it (buy: live ask > `refPrice` × 1.015; sell: live
   bid < `refPrice` × 0.985), skip it and record `failed` with the message `Price moved before sending`.
   Closing orders (`opening: false`) are never skipped for price: a stop-loss must go out in a fast
   market. With no `refPrice`, skip this check.
4. On a transport error, retry `place_tool` once with the **same** `ref_id`. Never retry a review alert.
5. Never approve or decline Robinhood trade approvals. Never cancel an order unless it is listed in
   `outbox.cancels`.
6. If the desk is in paper mode, or `desk/settings` is missing, stop after step 2 and report why.
7. Do not commit or push anything. The working folder is scratch space.
8. Never run step 4 again once `out/outbox.json` exists: a new run would create new orders with new
   `ref_id`s. If `run` says the cycle already finished, continue at step 6 with the orders in that file.
9. Send nothing late: before each order, run `node crowsnest/bin/autopilot.mjs deadline $WORK`. Once it
   says `"late": true`, do not review or place that order or any after it; record each as `failed` with
   the message `Too late to send`. The next check-in decides again with fresh prices.

## Steps

**0. Code.** In the repository, make sure `crowsnest/` exists. If not, check out the branch named
in the task prompt (`git fetch origin <branch> && git checkout <branch>`). If the session has no copy
of the repository at all, attach it with the `add_repo` tool (read access is enough), clone it as that
tool says, then check out the branch. No `npm install` is needed.
Set `WORK` to a new empty folder in your scratchpad (or `/tmp/crowsnest-run-<timestamp>`).

**1. Which check-in.** Run `node crowsnest/bin/autopilot.mjs slot`. If `kind` is `none`, stop: the
market is closed today.

**2. Read the desk database** with the `ArtifactData` tool (`url` = the artifact URL):
- `list` collection `desk` with `out_dir` = `$WORK/inputs/db`
- `query` collection `intents`, `query.where` = `[["status","in",["watching","planned","proposed","queued","needs_review","sending","sent","pending_approval","working"]]]`, `query.limit` = 100, `out_dir` = `$WORK/inputs/db`
- `query` collection `cycles`, `query.order_by` = `{"field":"at","direction":"desc"}`, `query.limit` = 6, `out_dir` = `$WORK/inputs/db`

Then write `$WORK/inputs/versions.json`: an object mapping `"<collection>/<doc_id>"` to the
`version` each read reported, for example `{"desk/state": 12, "intents/3f2c…": 4}`, with an entry for
**every** document saved under `inputs/db`. The writes in step 8 need these, and `run` refuses to start
if one is missing.

Read `$WORK/inputs/db/desk/settings.json`. If `broker` is not `"live"`, stop and report that the desk
is in paper mode.

**3. Robinhood payloads.** Use the account in `settings.accountNumber`; confirm with `get_accounts`
that it is the account with `agentic_allowed: true`. Call:

| key in robinhood.json | tool and input |
| --- | --- |
| `accounts` | `get_accounts` |
| `approvalSetting` | `get_trade_approval_setting` (account_number) |
| `portfolio` | `get_portfolio` (account_number) |
| `equityPositions` | `get_equity_positions` (account_number) |
| `optionPositions` | `get_option_positions` (account_number, nonzero: true) |
| `equityQuotes` | `get_equity_quotes` (symbols = every stock held) |
| `optionInstruments` | `get_option_instruments` (ids = every held option's option_id, comma-separated) — skip if none |
| `optionQuotes` | `get_option_quotes` (instrument_ids = the same ids) — skip if none |
| `equityOrders` | `get_equity_orders` (account_number, created_at_gte = 7 days ago, YYYY-MM-DD) |
| `optionOrders` | `get_option_orders` (account_number, created_at_gte = 7 days ago) |
| `approvals` | `get_trade_approvals` (account_number) |
| `pnl` | `get_pnl_trade_history` (account_number, span: "week") |
| `fundamentals` | `get_equity_fundamentals` (symbols = `settings.watchlist` plus every stock held, at most 10 per call) — an **array** with each call's `data` object |

Write them to `$WORK/inputs/robinhood.json` as one object with those keys, each value being the
tool result's `data` object exactly as returned.

**4. Run the cycle.** `node crowsnest/bin/autopilot.mjs run $WORK`
- Exit code **3** with `"status": "need_agents"`: go to step 5, then run this command again.
- Exit code **0**: the cycle is complete; go to step 6.
- Exit code **1** saying the cycle already finished: go to step 6 (hard rule 8).
- Any other exit code: report the error and stop.

**5. Agents.** The output lists prompt files and the reply file each agent must write.
- **Scout and Analyst** (they come together): spawn two subagents in parallel with the Agent tool. Give
  each this task: *"Read `<prompt file>` and do exactly what it asks. Write only the JSON object it asks
  for to `<reply file>` with the Write tool. Do not call any other tools."*
- **Head Honcho**: you are the Head Honcho. Read the prompt yourself, think it through carefully, and
  write your JSON reply to the reply file.
- **Operator**: spawn one subagent with the same instruction as Scout and Analyst.

Check that each reply file holds a single valid JSON object, then repeat step 4.

**6. Send the orders** in `$WORK/out/outbox.json` (`orders` and `cancels`; both may be empty).

First re-check the owner's switches, which may have changed while the agents worked: `ArtifactData`
`get` `desk/settings` and `desk/state`.
- If `broker` is not `"live"` or `execution` is not `"auto"`: send nothing and cancel nothing. Record
  every order as `failed` with the message `Owner changed settings before sending`.
- If `killSwitch` is true: send only orders with `opening: false` (closing orders). Record each opening
  order as `failed` with the message `Kill switch is on`.

Then, for each order you are sending:

a. For each order's `legsToResolve` entry, call `get_option_instruments` with `chain_symbol`,
   `expiration_dates` = `expiration_date`, `strike_price`, `type`. Put the returned instrument's `id`
   into `input.legs[index].option_id`, and remember `occ → id`.
b. Check the live price (rule 3): `get_equity_quotes` for stock orders, `get_option_quotes` for option
   legs.
c. Call `review_tool` with `input` minus `ref_id`, plus the fields in `review_extra`.
d. If the review has alerts → result `needs_review`. Otherwise call `place_tool` with `input`
   (including `ref_id`). If the response says the customer must approve → `pending_approval`; if it
   placed → `sent`; if Robinhood refused it → `failed` with the message.
   If the call itself failed with no clear answer (timeout, connection or server error), retry it once
   with the same `ref_id` (hard rule 4). If that also gets no clear answer, call `get_equity_orders`
   (or `get_option_orders`) with `account_number` and `created_at_gte` = today, and look for an order
   whose `ref_id` equals this order's `ref_id`: if found, record `sent` with its id; if not, `failed`.
e. For each entry in `cancels`, call its `tool` with its `input`.

Write `$WORK/results.json`: an array with one entry for **every** order in the outbox, sent or not
(`finalize` refuses a file that leaves one out):
`{"intentId": "...", "status": "sent|pending_approval|needs_review|failed", "orderId": "...", "alerts": [], "message": "", "optionIds": {"<occ>": "<robinhood id>"}}`.
If there were no orders, write `[]`.

**7. Finalize.** `node crowsnest/bin/autopilot.mjs finalize $WORK`

**8. Write back.** For each `$WORK/out/writes-N.json` file (in order), call `ArtifactData` with
`action: "batch"`, `url` = the artifact URL, and `writes` = the array in that file (each entry already
has `op`, `collection`, `doc_id`, `file_path` and, for documents that existed, `if_version`). Documents
that existed are written as `update` with only the fields this run changed, so they never undo what the
owner changed meanwhile (for example a kill switch pressed during the run).

A batch is all-or-nothing: if it is refused, nothing was written. Fix the entry the refusal names and
send the **whole** batch again, until it commits (at most 5 tries, then report the error):
- The document changed since step 2: set that entry's `if_version` to the current version the refusal
  names. Do not change its file: it holds only this run's changes, which are safe to apply on top.
- A `set` of a new document that now exists: `get` it, then change that entry to `op: "update"` with its
  `if_version`.

**9. Report** in a few lines: the cycle headline from `$WORK/out/summary.txt`, every order sent and its
status, and anything that needs the owner (orders needing review, approvals waiting in the Robinhood
app, errors).
