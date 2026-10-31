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
AMOUNT_PATTERN = re.compile(r"(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s*원")
# Balances and running totals are not the transaction amount.
BALANCE_PATTERN = re.compile(r"(?:잔액|누적\S*|한도\S*)\s*[:：]?\s*[\d,]+\s*원")
COVERAGE_STATUSES = ("parsed", "raw_unparsed", "no_alert", "no_source")
SKIPPED_CLASSIFICATIONS = {"zero-value informational income"}
CARD_BRANDS = ("삼성", "신한", "하나", "국민", "현대", "롯데", "우리", "카카오", "네이버", "페이코")


def find_export(banksalad_dir, start, end, closed_month=False):
    """Latest-ending export whose folder range covers [start, end].

    A closed month needs an export that ends after the month: an export taken
    on the last day can still miss that evening.
    """
    chosen = None
    for folder in sorted(path for path in banksalad_dir.iterdir() if path.is_dir()):
        match = EXPORT_DATE_RANGE.fullmatch(folder.name)
        if not match or not (folder / "source.xlsx").exists():
            continue
        first, last = match.groups()
        covers = last > end if closed_month else last >= end
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
        # A malformed settings table (hand edit) only loses the tables, not the month total and coverage.
        # A sum mismatch is a code bug (the two expense rules drifted) and still fails the run loudly.
        try:
            tables = breakdown(report["transactions"], closed_month, read_settings(spending_dir),
                               EXPORT_DATE_RANGE.fullmatch(export.name).group(1) <= previous_start)
        except (KeyError, TypeError, AttributeError, ValueError, json.JSONDecodeError) as error:
            tables = {"error": f"{type(error).__name__}: {error}"}
        for name in (() if "error" in tables else ("by_instrument", "by_category")):
            total = sum((Decimal(group["amount"]) for group in tables[name]), Decimal(0))
            if total != Decimal(str(monthly["total_expense"])):
                raise ValueError(f"{name} sum {total} != total_expense {monthly['total_expense']}")
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


def in_day_window(day, day_from, day_to):
    """dayFrom..dayTo inclusive; a window like 28..3 wraps over the month end."""
    return day_from <= day <= day_to if day_from <= day_to else day >= day_from or day <= day_to


def assign_fixed(rows, entries, resolve):
    """Each row pays at most one fixed cost: same instrument, inside the day window, merchant key contained.

    Longer merchant keys claim rows first, so "KT통신요금" is not taken by a broader "KT..." entry.
    """
    claimed = set()
    payments = {entry["name"]: [] for entry in entries}
    for entry in sorted(entries, key=lambda item: -len(normalize_merchant(item["merchant"]))):
        key = normalize_merchant(entry["merchant"])
        for index, (item, spent) in enumerate(rows):
            if (index in claimed or resolve(item)[0] != entry["instrument"]
                    or not in_day_window(int(item["date"][8:10]), entry["dayFrom"], entry["dayTo"])
                    or key not in normalize_merchant(item["description"])):
                continue
            claimed.add(index)
            payments[entry["name"]].append({"date": item["date"], "amount": amount_text(spent)})
    return {name: sorted(paid, key=lambda payment: payment["date"]) for name, paid in payments.items()}


def breakdown(transactions, month, settings, previous_covered):
    """Card, category and fixed-cost tables for a closed month (Requests "소비 보고 카드별·항목별·고정비" 2단계).

    Sums use spent_amount, so by_instrument and by_category both add up to monthly.total_expense.
    A payment-route alias (e.g. 네이버페이 간편결제 → the linked card) folds into its card and keeps the route.
    """
    aliases = {entry["from"]: entry for entry in settings.get("instrumentAliases", [])}

    def resolve(item):
        instrument = (item["payment_instrument"] or "").strip() or "(없음)"
        alias = aliases.get(instrument)
        return (alias["to"], alias.get("via") or instrument) if alias else (instrument, None)

    overrides = {normalize_merchant(entry["merchant"]): entry for entry in settings.get("merchantCategories", [])}

    def spent_rows(target):
        return [(item, spent) for item in transactions if item["date"] and item["date"][:7] == target
                for spent in [spent_amount(item)] if spent is not None]

    rows = spent_rows(month)
    instruments = {}
    for item, spent in rows:
        name, via = resolve(item)
        bucket = instruments.setdefault(name, {"instrument": name, "count": 0, "amount": Decimal(0), "routes": {}})
        bucket["count"] += 1
        bucket["amount"] += spent
        if via:
            bucket["routes"][via] = bucket["routes"].get(via, Decimal(0)) + spent
    categories = {}
    for item, spent in rows:
        override = overrides.get(normalize_merchant(item["description"]))
        name = (override or {}).get("category") or item["original_category"] or "미분류"
        bucket = categories.setdefault(name, {"category": name, "count": 0, "amount": Decimal(0), "owner_override": 0})
        bucket["count"] += 1
        bucket["amount"] += spent
        bucket["owner_override"] += 1 if override else 0
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

    return {"by_instrument": rows_out(instruments, "instrument"), "by_category": rows_out(categories, "category"),
            "fixed": fixed, "previous_month": previous_month if previous_covered else None}


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
