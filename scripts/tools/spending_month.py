#!/usr/bin/env python3
"""Close a spending month and audit which Banksalad rows the phone alerts missed.

Decision `월별-지출-정본`: Banksalad is the ledger for closed-month totals; the
alert summaries are provisional and only used for cross-checking. Inputs are
read-only. Each Banksalad row gets one alert coverage status:

- parsed:        a parsed alert (daily .summary.json entry) matches it
- raw_unparsed:  a raw alert mentions the amount but no parser read it
- no_alert:      alerts were being collected that day but none saw it
- no_source:     no alert collection existed that day (before rollout, outage)

Grouping these by payment instrument shows where new alert sources are needed.
The matcher prefers under-reporting coverage to over-reporting it: a wrong
"parsed" hides exactly the gap this tool exists to find.
"""

import argparse
import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import re

from banksalad_audit import (EXPORT_DATE_RANGE, amount_text, amount_value, build_report,
                             monthly_breakdown)

KST = timezone(timedelta(hours=9))
# Banksalad and alert clocks differed by at most 53 seconds in the owner-confirmed sample.
MATCH_WINDOW = timedelta(minutes=10)
# 하나카드 자동납부 alerts arrive the next morning; see assign_delayed().
DELAYED_WINDOW = timedelta(hours=48)
RAW_ECHO_WINDOW = timedelta(minutes=2)
# 간편결제 and the card it charged notify within seconds (owner sample: 0-2 s); see link_cards().
LINK_WINDOW = timedelta(minutes=3)
AMOUNT_PATTERN = re.compile(r"(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s*원")
# Balances and running totals are not the transaction amount.
BALANCE_PATTERN = re.compile(r"(?:잔액|누적\S*|한도\S*)\s*[:：]?\s*[\d,]+\s*원")
COVERAGE_STATUSES = ("parsed", "raw_unparsed", "no_alert", "no_source")
SKIPPED_CLASSIFICATIONS = {"zero-value informational income"}
CARD_BRANDS = ("삼성", "신한", "하나", "국민", "현대", "롯데", "우리", "카카오", "네이버", "페이코")


def workbook_created_kst(path):
    """KST date the export workbook was created (docProps created), or None when unreadable.

    openpyxl drops the timezone suffix and returns a naive value, which is read as UTC here. Banksalad
    writes "...Z" (UTC). A "+09:00" value would land 9 hours late; Node (exportCreatedKst) reads the raw
    XML correctly and decides ready/waiting first, so that edge only ever errs towards waiting.
    """
    try:
        from openpyxl import load_workbook
        book = load_workbook(path, read_only=True)
        created = book.properties.created
        book.close()
    except Exception:  # noqa: BLE001 — an unreadable workbook simply proves nothing about its export time
        return None
    if created is None:
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created.astimezone(KST).date().isoformat()


def find_export(banksalad_dir, start, end, closed_month=False):
    """Latest-ending export whose folder range covers [start, end].

    A closed month needs an export that ends after the month: an export taken
    on the last day can still miss that evening. A range that ends on the last
    day also counts when the workbook itself was created after the month
    (owner exports "1st..last day" the next day, 2026-11-01).
    """
    chosen = None
    for folder in sorted(path for path in banksalad_dir.iterdir() if path.is_dir()):
        match = EXPORT_DATE_RANGE.fullmatch(folder.name)
        if not match or not (folder / "source.xlsx").exists():
            continue
        first, last = match.groups()
        covers = (last > end or (last == end and (workbook_created_kst(folder / "source.xlsx") or "") > end)
                  if closed_month else last >= end)
        if first <= start and covers and (chosen is None or last > chosen[1]):
            chosen = (folder, last)
    if chosen is None:
        raise ValueError(f"No Banksalad export covers {start}..{end}"
                         + (" (closed month needs an export ending after the month)" if closed_month else ""))
    return chosen[0]


def transaction_moment(transaction):
    """KST datetime, or None when the export carries no real clock (00:00, as banksalad_audit)."""
    clock = transaction["time"]
    if not clock or clock.startswith("00:00"):
        return None
    return datetime.fromisoformat(f"{transaction['date']}T{clock}").replace(tzinfo=KST)


def days_between(start, end):
    current = date.fromisoformat(start)
    while current <= date.fromisoformat(end):
        yield current.isoformat()
        current += timedelta(days=1)


def shift(day, days):
    return (date.fromisoformat(day) + timedelta(days=days)).isoformat()


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def load_parsed_alerts(spending_dir, start, end):
    """One alert per payment: the same payment parsed from 카카오톡 and the card app merges.

    Merge key is minute, amount, card and status; the merged summary indexes are kept as evidence.
    """
    merged = {}
    for day in days_between(start, end):
        path = spending_dir / day[:4] / f"{day}.summary.json"
        if not path.exists():
            continue
        for index, entry in enumerate(json.loads(path.read_text(encoding="utf-8")).get("entries", [])):
            if not entry.get("at") or not entry.get("amount"):
                continue
            at = datetime.fromisoformat(entry["at"].replace("Z", "+00:00")).astimezone(KST)
            key = (at.replace(second=0, microsecond=0), Decimal(entry["amount"]), entry.get("card"),
                   entry.get("status"))
            if key in merged:
                merged[key]["summary_refs"].append(f"{path.name}#{index}")
                continue
            merged[key] = {"at": at, "amount": key[1], "card": entry.get("card"),
                           "card_id": entry.get("cardMask") or entry.get("cardLast4"),
                           "merchant": entry.get("merchant"), "status": entry.get("status"),
                           "summary_refs": [f"{path.name}#{index}"]}
    return sorted(merged.values(), key=lambda alert: alert["at"])


def alert_amounts(*texts):
    found = set()
    for text in texts:
        for value in AMOUNT_PATTERN.findall(BALANCE_PATTERN.sub("", str(text or ""))):
            found.add(Decimal(value.replace(",", "")))
    return found


def load_raw_alerts(spending_dir, events_dir, start, end):
    """Unparsed text from both alert paths; amounts are pulled from the text."""
    alerts = []
    for day in days_between(start, end):
        for record in read_jsonl(spending_dir / day[:4] / f"{day}.jsonl"):
            if not record.get("postedAt"):
                continue
            alerts.append({"source": "kakao-app", "app": record.get("appLabel") or record.get("packageName"),
                           "at": datetime.fromtimestamp(record["postedAt"] / 1000, KST),
                           "amounts": alert_amounts(record.get("sender"), record.get("body"))})
        if events_dir is None:
            continue
        for event in read_jsonl(events_dir / day[:4] / f"{day}.jsonl"):
            payload = event.get("payload") or {}
            if event.get("type") != "notification.received" or payload.get("category") != "소비":
                continue
            posted = payload.get("postedAt") or event.get("occurred_at")
            if not posted:
                continue
            alerts.append({"source": "argos", "app": payload.get("appLabel") or payload.get("packageName"),
                           "at": datetime.fromtimestamp(posted / 1000, KST),
                           "amounts": alert_amounts(payload.get("sender"), (payload.get("rawExtras") or {}).get("title"),
                                                    payload.get("body"))})
    return alerts


def alert_source_days(spending_dir, events_dir, start, end):
    """Which days had any alert collection, so silence is not mistaken for a gap."""
    days = {}
    for day in days_between(start, end):
        sources = []
        if (spending_dir / day[:4] / f"{day}.jsonl").exists():
            sources.append("kakao-app")
        if events_dir is not None and any(
                event.get("type") == "notification.received"
                for event in read_jsonl(events_dir / day[:4] / f"{day}.jsonl")):
            sources.append("argos")
        days[day] = sources
    return days


def near(transaction, moment, at):
    if moment is None:
        return at.date().isoformat() == transaction["date"]
    return abs(at - moment) <= MATCH_WINDOW


def outflow(transaction):
    # Payment alerts (카드 승인·송금) are always money leaving; inflows never match them.
    return amount_value(transaction["signed_amount"]) < 0


def card_matches(alert, transaction):
    card = alert.get("card") or ""
    return card in CARD_BRANDS and card in transaction["payment_instrument"]


def max_matching(edges):
    """Maximum one-to-one matching; edges are (cost, left, right), tried cheapest first.

    Kuhn's augmenting paths give the largest number of pairs, so a slightly
    closer pair can no longer strand two rows that could both be matched.
    """
    adjacency = defaultdict(list)
    for cost, left, right in sorted(edges):
        adjacency[left].append(right)
    owner = {}

    def augment(left, seen):
        for right in adjacency[left]:
            if right in seen:
                continue
            seen.add(right)
            if right not in owner or augment(owner[right], seen):
                owner[right] = left
                return True
        return False

    for left in sorted(adjacency, key=lambda key: min(cost for cost, row, _ in edges if row == key)):
        augment(left, set())
    return {left: right for right, left in owner.items()}


def assign_parsed(transactions, alerts):
    edges = []
    for row_index, transaction in enumerate(transactions):
        if not outflow(transaction):
            continue
        amount = -amount_value(transaction["signed_amount"])
        moment = transaction_moment(transaction)
        for alert_index, alert in enumerate(alerts):
            if alert["amount"] == amount and near(transaction, moment, alert["at"]):
                # Date-only rows rank after any clocked match of the same alert.
                gap = abs(alert["at"] - moment) if moment else timedelta(days=1)
                edges.append((gap, row_index, alert_index))
    return max_matching(edges)


def assign_delayed(transactions, alerts, matched, used):
    """Late alerts pair only when unambiguous: clocked row, same card brand, one candidate each way."""
    candidates = defaultdict(list)
    for row_index, transaction in enumerate(transactions):
        moment = transaction_moment(transaction)
        if row_index in matched or moment is None or not outflow(transaction):
            continue
        amount = -amount_value(transaction["signed_amount"])
        for alert_index, alert in enumerate(alerts):
            lag = alert["at"] - moment
            if (alert_index not in used and alert["amount"] == amount and card_matches(alert, transaction)
                    and timedelta(0) <= lag <= DELAYED_WINDOW):
                candidates[row_index].append(alert_index)
    rows_by_alert = defaultdict(list)
    for row_index, alert_indexes in candidates.items():
        for alert_index in alert_indexes:
            rows_by_alert[alert_index].append(row_index)
    delayed = {}
    for row_index, alert_indexes in candidates.items():
        if len(alert_indexes) == 1 and len(rows_by_alert[alert_indexes[0]]) == 1:
            delayed[row_index] = alert_indexes[0]
    return delayed


def assign_raw(transactions, raw_alerts, unmatched_rows, used_alerts):
    """Raw text that is just the echo of a parsed alert is not evidence of a parser gap."""
    free = [index for index, raw in enumerate(raw_alerts)
            if not any(alert["amount"] in raw["amounts"] and abs(alert["at"] - raw["at"]) <= RAW_ECHO_WINDOW
                       for alert in used_alerts)]
    edges = []
    for row_index in unmatched_rows:
        transaction = transactions[row_index]
        amount = abs(amount_value(transaction["signed_amount"]))
        moment = transaction_moment(transaction)
        for raw_index in free:
            raw = raw_alerts[raw_index]
            if amount in raw["amounts"] and near(transaction, moment, raw["at"]):
                gap = abs(raw["at"] - moment) if moment else timedelta(days=1)
                edges.append((gap, row_index, raw_index))
    return max_matching(edges)


def assign_coverage(transactions, parsed_alerts, raw_alerts, source_days):
    """Annotate rows in place; returns parsed expense alerts left without a row."""
    matched = assign_parsed(transactions, parsed_alerts)
    delayed = assign_delayed(transactions, parsed_alerts, matched, set(matched.values()))
    matched.update(delayed)
    used = set(matched.values())
    unmatched = [index for index in range(len(transactions)) if index not in matched]
    raw_matched = assign_raw(transactions, raw_alerts, unmatched, [parsed_alerts[index] for index in used])
    for row_index, transaction in enumerate(transactions):
        transaction["alert_raw_sources"] = []
        if row_index in matched:
            alert = parsed_alerts[matched[row_index]]
            transaction["alert_coverage"] = "parsed"
            transaction["alert_match"] = {"summary_refs": alert["summary_refs"], "merchant": alert["merchant"],
                                          "card": alert["card"], "status": alert["status"],
                                          "delayed": row_index in delayed}
        elif row_index in raw_matched:
            raw = raw_alerts[raw_matched[row_index]]
            transaction["alert_coverage"] = "raw_unparsed"
            transaction["alert_raw_sources"] = [f"{raw['source']}:{raw['app']}"]
        elif source_days.get(transaction["date"]):
            transaction["alert_coverage"] = "no_alert"
        else:
            transaction["alert_coverage"] = "no_source"
    return [alert for index, alert in enumerate(parsed_alerts)
            if index not in used and alert["status"] == "expense"]


def coverage_groups(transactions, key):
    groups = defaultdict(lambda: {status: {"count": 0, "amount": Decimal(0)} for status in COVERAGE_STATUSES})
    for transaction in transactions:
        bucket = groups[transaction[key] or "(없음)"][transaction["alert_coverage"]]
        bucket["count"] += 1
        bucket["amount"] += abs(amount_value(transaction["signed_amount"]))
    rows = []
    for name, statuses in groups.items():
        total = sum(item["count"] for item in statuses.values())
        rows.append({key: name, "count": total,
                     "missed_count": statuses["raw_unparsed"]["count"] + statuses["no_alert"]["count"],
                     **{status: {"count": value["count"], "amount": amount_text(value["amount"])}
                        for status, value in statuses.items()}})
    return sorted(rows, key=lambda row: (-row["missed_count"], -row["count"], row[key]))


def build_month(banksalad_dir, spending_dir, events_dir, start, end, closed_month=None):
    export = find_export(banksalad_dir, start, end, closed_month=bool(closed_month))
    decisions = export / "owner-decisions.json"
    report = build_report(export / "source.xlsx", owner_decisions=decisions if decisions.exists() else None)
    # Route duplicates are dropped after build_report, so report's own summary fields predate them.
    # A malformed settings table (hand edit) only loses the tables, not the month total and coverage.
    settings, settings_error, route_duplicates = {}, None, []
    try:
        settings = read_settings(spending_dir)
        route_duplicates = drop_route_duplicates(report["transactions"], settings)
    except (KeyError, TypeError, AttributeError, ValueError, json.JSONDecodeError) as error:
        settings_error = f"{type(error).__name__}: {error}"
    # Rows and alerts one day either side take part in matching so boundary
    # pairs consume each other; only rows inside the period are reported.
    padded_start, padded_end = shift(start, -1), shift(end, 1)
    matching_rows = [item for item in report["transactions"]
                     if padded_start <= item["date"] <= padded_end
                     and item["aggregation_status"] != "excluded_owner_confirmed_duplicate"
                     and item["classification"] not in SKIPPED_CLASSIFICATIONS
                     and amount_value(item["signed_amount"])]
    source_days = alert_source_days(spending_dir, events_dir, padded_start, padded_end)
    alert_only = assign_coverage(matching_rows, load_parsed_alerts(spending_dir, padded_start, padded_end),
                                 load_raw_alerts(spending_dir, events_dir, padded_start, padded_end),
                                 source_days)
    transactions = [item for item in matching_rows if start <= item["date"] <= end]
    alert_only = [alert for alert in alert_only if start <= alert["at"].date().isoformat() <= end]
    monthly = None
    if closed_month:
        monthly = next((row for row in monthly_breakdown(report["transactions"], (start, end))
                        if row["month"] == closed_month), None)
        if monthly is None:
            raise ValueError(f"Export has no transactions in {closed_month}")
    counts = {status: sum(item["alert_coverage"] == status for item in transactions)
              for status in COVERAGE_STATUSES}
    counts["parsed_delayed"] = sum(item.get("alert_match", {}).get("delayed", False) for item in transactions)
    period_days = {day: sources for day, sources in source_days.items() if start <= day <= end}
    tables = None
    if closed_month:
        previous_start = shift(start, -1)[:7] + "-01"
        # A sum mismatch is a code bug (the two expense rules drifted) and still fails the run loudly.
        try:
            if settings_error:
                raise ValueError(settings_error)
            # From the previous month on: its fixed-cost payments are compared too.
            window_start = shift(previous_start, -1)
            linked = link_cards([item for item in report["transactions"]
                                 if item["date"] and window_start <= item["date"] <= padded_end],
                                load_parsed_alerts(spending_dir, window_start, padded_end), settings)
            # The card alert behind a 간편결제 row is that row's payment, not an alert-only one.
            paid = {(alert["at"], alert["amount"], alert["card"], alert["status"]) for alert in linked.values()}
            alert_only = [alert for alert in alert_only
                          if (alert["at"], alert["amount"], alert["card"], alert["status"]) not in paid]
            tables = breakdown(report["transactions"], closed_month, settings,
                               EXPORT_DATE_RANGE.fullmatch(export.name).group(1) <= previous_start)
        except (KeyError, TypeError, AttributeError, ValueError, json.JSONDecodeError) as error:
            tables = {"error": f"{type(error).__name__}: {error}"}
        for name in (() if "error" in tables else ("by_instrument", "by_category")):
            total = sum((Decimal(group["amount"]) for group in tables[name]), Decimal(0))
            if total != Decimal(str(monthly["total_expense"])):
                raise ValueError(f"{name} sum {total} != total_expense {monthly['total_expense']}")
        if "error" not in tables:
            living = next((Decimal(g["amount"]) for g in tables["outflows"]["groups"] if g["group"] == "생활 지출"), Decimal(0))
            if living != Decimal(str(monthly["total_expense"])):
                raise ValueError(f"outflows 생활 지출 {living} != total_expense {monthly['total_expense']}")
            row_sum = sum((Decimal(row["amount"]) for row in tables["outflows"]["rows"]), Decimal(0))
            if row_sum != sum((Decimal(tables["outflows"][key]) for key in ("total", "pending_total", "overlap_total",
                                                                               "reimbursed_total")),
                              Decimal(0)):
                raise ValueError(f"outflows rows {row_sum} != groups")
    return {
        "schema_version": 1,
        "decision_key": "월별-지출-정본",
        "period": {"start": start, "end": end, "closed_month": closed_month},
        "source": {"export": export.name, "source_file_sha256": report["source_file_sha256"],
                   "owner_decisions": decisions.exists()},
        "alert_sources": {
            "days_with_alerts": sum(bool(sources) for sources in period_days.values()),
            "days_without_alerts": sorted(day for day, sources in period_days.items() if not sources),
            "first_day": {source: next((day for day, sources in period_days.items() if source in sources), None)
                          for source in ("kakao-app", "argos")},
        },
        "monthly": monthly,
        "breakdown": tables,
        "route_duplicates": [item for item in route_duplicates if start <= item["date"] <= end],
        "settings_error": settings_error,
        "coverage": {
            "transactions": len(transactions), **counts,
            "by_instrument": coverage_groups(transactions, "payment_instrument"),
            "by_classification": coverage_groups(transactions, "classification"),
        },
        "missed": [{"source_row": item["source_row"], "date": item["date"], "time": item["time"],
                    "payment_instrument": item["payment_instrument"], "description": item["description"],
                    "classification": item["classification"], "signed_amount": item["signed_amount"],
                    "alert_coverage": item["alert_coverage"], "alert_raw_sources": item["alert_raw_sources"]}
                   for item in transactions if item["alert_coverage"] in ("raw_unparsed", "no_alert")],
        "alert_only": [{"at": alert["at"].isoformat(), "amount": amount_text(alert["amount"]),
                        "card": alert["card"], "merchant": alert["merchant"],
                        "summary_refs": alert["summary_refs"]}
                       for alert in alert_only],
    }


MERCHANT_NOISE = re.compile(r"\(?자동납부\)?|\(주\)|㈜|주식회사")
MERCHANT_PUNCT = re.compile(r"[\s_()\-.·]")


def normalize_merchant(name):
    """Same normalisation as spending-tables.mjs normalizeMerchant (alerts and exports spell shops differently)."""
    return MERCHANT_PUNCT.sub("", MERCHANT_NOISE.sub("", str(name or ""))).lower()


def read_settings(spending_dir):
    """Owner-confirmed tables (cardMap etc.); validated on write by spending-settings.mjs."""
    path = spending_dir / "settings.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def spent_amount(item):
    """The amount monthly_breakdown adds to total_expense for this row, else None (keep the two rules equal)."""
    if not item["date"] or item["aggregation_status"] == "excluded_owner_confirmed_duplicate":
        return None
    amount = amount_value(item["signed_amount"])
    if amount is None or amount >= 0:
        return None
    if item["classification"] == "expense" or item.get("spending_treatment") == "unverified_usage_expense":
        return -amount
    return None


def assign_fixed(rows, entries, resolve):
    """Each row pays at most one fixed cost: same instrument, merchant key contained.

    The payment date never decides it (owner 2026-11-01): a fixed cost is the item itself, and
    dayFrom..dayTo is only the usual date shown for upcoming payments.

    Longer merchant keys claim rows first, so "KT통신요금" is not taken by a broader "KT..." entry.
    """
    claimed = set()
    payments = {entry["name"]: [] for entry in entries}
    for entry in sorted(entries, key=lambda item: -len(normalize_merchant(item["merchant"]))):
        key = normalize_merchant(entry["merchant"])
        for index, (item, spent) in enumerate(rows):
            if (index in claimed or resolve(item)[0] != entry["instrument"]
                    or key not in normalize_merchant(item["description"])):
                continue
            claimed.add(index)
            payments[entry["name"]].append({"date": item["date"], "amount": amount_text(spent)})
    return {name: sorted(paid, key=lambda payment: payment["date"]) for name, paid in payments.items()}


def drop_route_duplicates(transactions, settings):
    """Count once a payment that two 간편결제 routes both exported (owner confirmed 2026-10-31).

    네이버페이 and 페이코 each list the same 컬리·배민 payment at the same second for the same amount.
    duplicateRoutes [{keep, drop}] names the pair; the drop row is excluded like an owner-confirmed
    duplicate, so monthly_breakdown and spent_amount both skip it. Each keep row covers one drop row.
    Only pairs where both rows already count as spending qualify: dropping one beside a keep row that
    is not counted (review, transfer) would erase the payment from the total, which the sum check
    cannot see. Rows without a clock (00:00) never pair.
    """
    rules = [(entry["keep"].strip(), entry["drop"].strip()) for entry in settings.get("duplicateRoutes") or []]
    if {drop for _, drop in rules} & {keep for keep, _ in rules} or len({drop for _, drop in rules}) != len(rules):
        raise ValueError("duplicateRoutes 중복·연쇄")
    live = [item for item in transactions
            if spent_amount(item) is not None and transaction_moment(item) is not None]
    dropped, used = [], set()
    for keep_name, drop_name in rules:
        keeps = defaultdict(list)
        for item in live:
            if (item["payment_instrument"] or "").strip() == keep_name:
                keeps[(item["date"], item["time"], item["signed_amount"])].append(item)
        for item in live:
            if (item["payment_instrument"] or "").strip() != drop_name or id(item) in used:
                continue
            keep = next((other for other in keeps[(item["date"], item["time"], item["signed_amount"])]
                         if id(other) not in used), None)
            if keep is None:
                continue
            used.update((id(item), id(keep)))
            dropped.append({"source_row": item["source_row"], "date": item["date"], "time": item["time"],
                            "amount": amount_text(spent_amount(item)), "description": item["description"],
                            "dropped": drop_name, "kept": keep_name, "kept_source_row": keep["source_row"],
                            "owner_confirmed": bool(item.get("aggregation_decision")
                                                    or item.get("spending_treatment") == "consumption")})
            item["aggregation_status"] = "excluded_owner_confirmed_duplicate"
            # Keep any earlier owner decision on the row next to the new reason.
            item["aggregation_decision"] = {"paired_source_row": keep["source_row"],
                                            "treatment": "settings_duplicate_route",
                                            "previous_decision": item.get("aggregation_decision")}
    return dropped


def link_cards(transactions, alerts, settings):
    """Tag 간편결제-style rows with the card that actually paid; returns {row id: alert}.

    A 간편결제 (네이버페이·카카오페이·페이코 …) can charge any of several cards, so its row names no card.
    The card's own approval alert rings at the same moment for the same amount; when that alert's card
    is in cardMap the row is counted under that card. Rows already on a cardMap card, rows without a
    clock, and rows whose card alert never arrived (before collection, money/point payments) stay as
    they are. One alert pays for one row.
    """
    cards = {(entry["card"], entry["mask"]): entry["instrument"] for entry in settings.get("cardMap", [])}
    own = set(cards.values())
    candidates = [alert for alert in alerts
                  if alert["status"] == "expense" and (alert["card"], alert.get("card_id")) in cards]
    edges = []
    for row_index, item in enumerate(transactions):
        moment = transaction_moment(item)
        amount = spent_amount(item)
        if moment is None or amount is None or (item["payment_instrument"] or "").strip() in own:
            continue
        for alert_index, alert in enumerate(candidates):
            if alert["amount"] == amount and abs(alert["at"] - moment) <= LINK_WINDOW:
                edges.append((abs(alert["at"] - moment), row_index, alert_index))
    linked = {}
    for row_index, alert_index in max_matching(edges).items():
        alert = candidates[alert_index]
        transactions[row_index]["linked_card"] = cards[(alert["card"], alert["card_id"])]
        linked[row_index] = alert
    return linked


# 모든 출금(오너 2026-11-02: "지출 내역은 그 달의 모든 항목이 포함되어야 해 ... 임의로 제거하면 안된다").
# 생활 지출(total_expense와 같은 줄) 밖의 출금도 빠짐없이 묶음별로 남긴다. 카드대금·내 계좌 이동은 이미 다른 줄로
# 잡힌 돈이 다시 나간 기록이라 목록에는 보이되 합계에서만 뺀다(overlap, 오너 선택 "중복만 표시하고 합계 제외").
OUTFLOW_GROUPS = {
    "debt-service-unsplit": "대출 상환",
    "investment contribution": "저축·투자",
    "savings contribution": "저축·투자",
    "card settlement": "카드대금",
    "own-account transfer": "내 계좌 이동",
    "review": "확인 필요",
    # 남의 몫을 대신 결제하고 돌려받은 건(오너 확정 pass-through). 목록·묶음에는 남기고, 돌려받은 만큼은 합계 밖이다
    # (오너 2026-11-02 "나간 돈을 그대로 돌려받았고 받은 돈이 수입으로 잡힌 게 아니라 순액 증감에서 모두 빼는 게 맞다").
    # 돌려받지 못한 차액(예: 1,390,900 결제에 1,390,000 환급 → 900)은 실제로 나간 돈이라 합계에 남긴다.
    "third-party purchase pass-through": "대신 결제",
}
OVERLAP_GROUPS = {"카드대금", "내 계좌 이동"}
# 확인 필요(내 계좌인지 남에게 보낸 돈인지 아직 모르는 이체 등)는 오너 판정 전이라 합계에 넣지도 빼지도 않고 따로 센다.
PENDING_GROUPS = {"확인 필요"}
OUTFLOW_ORDER = ["생활 지출", "대출 상환", "저축·투자", "대신 결제", "확인 필요", "기타 출금", "카드대금", "내 계좌 이동"]


def outflow_group(item):
    """(group, amount) for an outgoing row, else None. 생활 지출 uses spent_amount so it equals total_expense."""
    spent = spent_amount(item)
    if spent is not None:
        return "생활 지출", spent
    if not item["date"] or item["aggregation_status"] == "excluded_owner_confirmed_duplicate":
        return None
    amount = amount_value(item["signed_amount"])
    if amount is None or amount >= 0:
        return None
    return OUTFLOW_GROUPS.get(item["classification"], "기타 출금"), -amount


def breakdown(transactions, month, settings, previous_covered):
    """Card, category and fixed-cost tables for a closed month (Requests "소비 보고 카드별·항목별·고정비" 2단계).

    Sums use spent_amount, so by_instrument and by_category both add up to monthly.total_expense.
    A 간편결제 row whose card alert was found (link_cards) folds into that card and keeps the route;
    one whose card is unknown stays under its own name. instrumentAliases is only for a route that
    always charges one card.
    """
    aliases = {entry["from"]: entry for entry in settings.get("instrumentAliases", [])}

    def resolve(item):
        instrument = (item["payment_instrument"] or "").strip() or "(없음)"
        if item.get("linked_card"):
            return item["linked_card"], instrument
        alias = aliases.get(instrument)
        return (alias["to"], alias.get("via") or instrument) if alias else (instrument, None)

    overrides = {normalize_merchant(entry["merchant"]): entry for entry in settings.get("merchantCategories", [])}

    def spent_rows(target):
        return [(item, spent) for item in transactions if item["date"] and item["date"][:7] == target
                for spent in [spent_amount(item)] if spent is not None]

    def by_instrument(month_rows):
        instruments = {}
        for item, spent in month_rows:
            name, via = resolve(item)
            bucket = instruments.setdefault(name, {"instrument": name, "count": 0, "amount": Decimal(0), "routes": {}})
            bucket["count"] += 1
            bucket["amount"] += spent
            if via:
                bucket["routes"][via] = bucket["routes"].get(via, Decimal(0)) + spent
        return instruments

    def by_category(month_rows):
        categories = {}
        for item, spent in month_rows:
            override = overrides.get(normalize_merchant(item["description"]))
            name = (override or {}).get("category") or item["original_category"] or "미분류"
            bucket = categories.setdefault(name, {"category": name, "count": 0, "amount": Decimal(0),
                                                  "owner_override": 0})
            bucket["count"] += 1
            bucket["amount"] += spent
            bucket["owner_override"] += 1 if override else 0
        return categories

    rows = spent_rows(month)
    year, number = (int(part) for part in month.split("-"))
    previous_month = f"{year - 1}-12" if number == 1 else f"{year}-{number - 1:02}"
    previous_rows = spent_rows(previous_month) if previous_covered else None
    entries = settings.get("fixedCosts", [])
    paid_now = assign_fixed(rows, entries, resolve)
    paid_before = assign_fixed(previous_rows, entries, resolve) if previous_rows is not None else None
    fixed = []
    for entry in entries:
        paid = paid_now[entry["name"]]
        total = sum((Decimal(payment["amount"]) for payment in paid), Decimal(0))
        before = None
        if paid_before is not None:
            before = sum((Decimal(payment["amount"]) for payment in paid_before[entry["name"]]), Decimal(0))
        fixed.append({"name": entry["name"], "instrument": entry["instrument"], "day_from": entry["dayFrom"],
                      "day_to": entry["dayTo"], "variable": entry["variable"],
                      "status": "paid" if paid else "missing", "payments": paid, "amount": amount_text(total),
                      "previous_amount": amount_text(before) if before is not None else None,
                      "change": amount_text(total - before) if before is not None and paid and before else None})

    def rows_out(groups, key):
        ordered = sorted(groups.values(), key=lambda group: (-group["amount"], group[key]))
        return [{**group, "amount": amount_text(group["amount"]),
                 **({"routes": {via: amount_text(value) for via, value in group["routes"].items()}}
                    if "routes" in group else {})} for group in ordered]

    # 지난달 같은 기준 합계(올림푸스 '지난달 대비', 2026-11-01). 내보내기가 지난달 전체를 덮지 않으면 null.
    previous = None
    if previous_rows is not None:
        previous = {"month": previous_month,
                    "total": amount_text(sum((spent for _, spent in previous_rows), Decimal(0))),
                    "by_instrument": rows_out(by_instrument(previous_rows), "instrument"),
                    "by_category": rows_out(by_category(previous_rows), "category")}
    # 줄마다 고정비 이름(assign_fixed와 같은 규칙: 같은 카드, 긴 가맹점 키 먼저).
    fixed_keys = sorted(((normalize_merchant(entry["merchant"]), entry) for entry in entries), key=lambda pair: -len(pair[0]))

    def fixed_for(item, name):
        description = normalize_merchant(item["description"])
        return next((entry["name"] for key, entry in fixed_keys
                     if entry["instrument"] == name and key in description), None)

    out_rows, groups = [], {}
    # 대신 결제 묶음(pass_through_group_id)마다 돌려받은 돈. 받은 날이 다른 달이어도 같은 묶음이면 센다.
    receipts = {}
    for item in transactions:
        group_id = item.get("pass_through_group_id")
        amount = amount_value(item["signed_amount"]) if group_id else None
        if group_id and amount is not None and amount > 0 and item["aggregation_status"] != "excluded_owner_confirmed_duplicate":
            receipts[group_id] = receipts.get(group_id, Decimal(0)) + amount
    # 같은 묶음에 결제가 여럿이면 날짜순으로 환급을 채운다.
    charges = sorted((item for item in transactions if item.get("pass_through_group_id") and item["date"]
                      and (amount_value(item["signed_amount"]) or 0) < 0),
                     key=lambda item: (item["date"], item["time"] or "", item["source_row"]))
    reimbursed_by_row = {}
    for item in charges:
        left = receipts.get(item["pass_through_group_id"], Decimal(0))
        covered = min(-amount_value(item["signed_amount"]), left)
        receipts[item["pass_through_group_id"]] = left - covered
        reimbursed_by_row[item["source_row"]] = covered
    # 오너 확정 중복·간편결제 이중 줄(drop_route_duplicates)은 같은 결제의 두 번째 줄이라 목록에서 빼고 건수만 남긴다.
    duplicates = {"count": 0, "amount": Decimal(0)}
    for item in transactions:
        if not item["date"] or item["date"][:7] != month:
            continue
        if item["aggregation_status"] == "excluded_owner_confirmed_duplicate":
            amount = amount_value(item["signed_amount"])
            if amount is not None and amount < 0:
                duplicates["count"] += 1
                duplicates["amount"] -= amount
            continue
        found = outflow_group(item)
        if found is None:
            continue
        group, amount = found
        name, via = resolve(item)
        override = overrides.get(normalize_merchant(item["description"]))
        fixed_cost = fixed_for(item, name) if group == "생활 지출" else None
        reimbursed = reimbursed_by_row.get(item["source_row"], Decimal(0)) if group == "대신 결제" else Decimal(0)
        out_rows.append({"date": item["date"], "time": item["time"], "description": item["description"],
                         "instrument": name, "via": via, "group": group, "classification": item["classification"],
                         "category": (override or {}).get("category") or item["original_category"] or "미분류",
                         "subcategory": (override or {}).get("subcategory") or item.get("original_subcategory") or None,
                         "fixed_cost": fixed_cost, "amount": amount_text(amount),
                         "reimbursed_amount": amount_text(reimbursed), "source_row": item["source_row"]})
        bucket = groups.setdefault(group, {"group": group, "overlap": group in OVERLAP_GROUPS,
                                           "pending": group in PENDING_GROUPS, "count": 0,
                                           "amount": Decimal(0), "reimbursed": Decimal(0), "instruments": {}})
        bucket["count"] += 1
        bucket["amount"] += amount
        bucket["reimbursed"] += reimbursed
        card = bucket["instruments"].setdefault(name, {"instrument": name, "count": 0, "amount": Decimal(0)})
        card["count"] += 1
        card["amount"] += amount
    out_rows.sort(key=lambda row: (row["date"], row["time"] or "", row["source_row"]))
    ordered = [groups[name] for name in OUTFLOW_ORDER if name in groups]
    outflows = {
        "total": amount_text(sum((g["amount"] - g["reimbursed"] for g in ordered if not g["overlap"] and not g["pending"]),
                                 Decimal(0))),
        "pending_total": amount_text(sum((g["amount"] for g in ordered if g["pending"]), Decimal(0))),
        "reimbursed_total": amount_text(sum((g["reimbursed"] for g in ordered if not g["overlap"] and not g["pending"]),
                                            Decimal(0))),
        "overlap_total": amount_text(sum((g["amount"] for g in ordered if g["overlap"]), Decimal(0))),
        "groups": [{"group": g["group"], "overlap": g["overlap"], "pending": g["pending"],
                    "reimbursed": g["reimbursed"] > 0, "reimbursed_amount": amount_text(g["reimbursed"]),
                    "count": g["count"], "amount": amount_text(g["amount"]),
                    "by_instrument": [{**card, "amount": amount_text(card["amount"])} for card in
                                      sorted(g["instruments"].values(), key=lambda c: (-c["amount"], c["instrument"]))]}
                   for g in ordered],
        "rows": out_rows,
        "excluded_duplicates": {"count": duplicates["count"], "amount": amount_text(duplicates["amount"])},
    }
    return {"by_instrument": rows_out(by_instrument(rows), "instrument"),
            "by_category": rows_out(by_category(rows), "category"),
            "fixed": fixed, "previous_month": previous_month if previous_covered else None, "previous": previous,
            "outflows": outflows}


def month_bounds(month):
    year, number = (int(part) for part in month.split("-"))
    return f"{month}-01", f"{month}-{calendar.monthrange(year, number)[1]:02}"


def safe_output(output, spending_dir, events_dir):
    """Write only under Spending/Monthly or entirely outside the input trees."""
    resolved = output.resolve()
    monthly = (spending_dir / "Monthly").resolve()
    if resolved.is_relative_to(monthly):
        return True
    inputs = [spending_dir.resolve()] + ([events_dir.resolve()] if events_dir else [])
    return not any(resolved.is_relative_to(root) for root in inputs)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spending-dir", required=True, type=Path, help="Vault spending dataset folder")
    parser.add_argument("--events-dir", type=Path, help="Vault Argos events folder; omit to skip")
    period = parser.add_mutually_exclusive_group(required=True)
    period.add_argument("--month", help="Closed month YYYY-MM: totals + coverage")
    period.add_argument("--range", nargs=2, metavar=("START", "END"),
                        help="Coverage only for YYYY-MM-DD..YYYY-MM-DD (no monthly totals)")
    parser.add_argument("--output", type=Path, help="Default: <spending-dir>/Monthly/<period>.json")
    parser.add_argument("--today", default=datetime.now(KST).date().isoformat(), help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if not arguments.spending_dir.is_dir():
        parser.error("--spending-dir must be an existing directory")
    if arguments.events_dir and not arguments.events_dir.is_dir():
        parser.error("--events-dir must be an existing directory")
    if arguments.month:
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", arguments.month):
            parser.error("--month must be YYYY-MM")
        start, end = month_bounds(arguments.month)
        if end >= arguments.today:
            parser.error("Month is not closed yet; use --range for a provisional coverage check")
        name = arguments.month
    else:
        start, end = arguments.range
        try:
            valid = date.fromisoformat(start) <= date.fromisoformat(end)
        except ValueError:
            valid = False
        if not valid:
            parser.error("--range needs START <= END as YYYY-MM-DD")
        name = f"coverage-{start}_{end}"
    output = arguments.output or arguments.spending_dir / "Monthly" / f"{name}.json"
    if not safe_output(output, arguments.spending_dir, arguments.events_dir):
        parser.error("--output must be under <spending-dir>/Monthly or outside the input folders")
    try:
        result = build_month(arguments.spending_dir / "Banksalad", arguments.spending_dir,
                             arguments.events_dir, start, end, arguments.month)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    coverage = result["coverage"]
    print(f"{name}: 거래 {coverage['transactions']}건 · 알림 파싱 {coverage['parsed']}"
          f"(지연 {coverage['parsed_delayed']}) · 미파싱 {coverage['raw_unparsed']} · "
          f"알림 없음 {coverage['no_alert']} · 수집 없던 날 {coverage['no_source']} · "
          f"알림에만 있음 {len(result['alert_only'])} → {output}")


if __name__ == "__main__":
    main()
