"""Regression tests for the monthly close / alert coverage audit (fabricated data only)."""

from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from test_banksalad_audit import workbook
from spending_month import KST, alert_amounts, build_month, find_export, safe_output


def row(day, clock, amount, instrument, description="Synthetic shop", kind="지출", category="식비"):
    return (day, clock, kind, category, "기타", description, amount, "KRW", instrument, "")


def millis(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=KST).timestamp() * 1000)


def utc_at(text):
    """KST wall clock -> the summary's real format, e.g. 2040-02-03T03:00:00.000Z."""
    moment = datetime.fromisoformat(text).replace(tzinfo=KST).astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def alert(at, amount, card=None, status="expense", merchant="가게"):
    return {"at": utc_at(at), "amount": amount, "card": card, "status": status, "merchant": merchant}


class Fixture:
    def __init__(self, root, rows, folder="2040-01-01_2040-03-05"):
        self.spending = root / "Spending"
        self.events = root / "Events"
        export = self.spending / "Banksalad" / folder
        export.mkdir(parents=True)
        workbook(export / "source.xlsx", rows)
        (self.spending / "2040").mkdir(parents=True)
        (self.events / "2040").mkdir(parents=True)

    def collecting(self, day, records=()):
        # A raw file for the day means alert collection was running.
        path = self.spending / "2040" / f"{day}.jsonl"
        path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

    def summary(self, day, entries):
        if not (self.spending / "2040" / f"{day}.jsonl").exists():
            self.collecting(day)
        path = self.spending / "2040" / f"{day}.summary.json"
        path.write_text(json.dumps({"date": day, "entries": entries}), encoding="utf-8")

    def argos(self, day, events):
        path = self.events / "2040" / f"{day}.jsonl"
        path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")

    def run(self, start, end, month=None):
        return build_month(self.spending / "Banksalad", self.spending, self.events, start, end, month)


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def statuses(self, result):
        return {item["source_row"]: item["alert_coverage"] for item in result["missed"]}

    def test_three_coverage_statuses(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -5000, "Card A"),
            row("2040-02-03", "13:00:00", -7000, "Wallet B"),
            row("2040-02-03", "14:00:00", -9000, "Bank C"),
        ])
        fixture.collecting("2040-02-03", [{"postedAt": millis("2040-02-03T13:01:00"), "appLabel": "지갑",
                                           "sender": "", "body": "7,000원 결제"}])
        fixture.summary("2040-02-03", [alert("2040-02-03T12:00:40", 5000, "삼성")])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual((result["coverage"]["parsed"], result["coverage"]["raw_unparsed"],
                          result["coverage"]["no_alert"]), (1, 1, 1))
        self.assertEqual(self.statuses(result), {3: "raw_unparsed", 4: "no_alert"})
        raw = next(item for item in result["missed"] if item["source_row"] == 3)
        self.assertEqual(raw["alert_raw_sources"], ["kakao-app:지갑"])

    def test_utc_summary_time_converts_to_kst(self):
        fixture = Fixture(self.root, [row("2040-02-03", "08:30:00", -5000, "Card A")])
        fixture.summary("2040-02-02", [])
        fixture.summary("2040-02-03", [alert("2040-02-03T08:30:00", 5000)])
        self.assertEqual(fixture.run("2040-02-03", "2040-02-03")["coverage"]["parsed"], 1)

    def test_argos_spending_notification_counts_as_raw_alert(self):
        fixture = Fixture(self.root, [row("2040-02-03", "09:00:00", -12000, "Bank C")])
        fixture.argos("2040-02-03", [
            {"type": "notification.received", "payload": {"category": "소비", "appLabel": "은행",
             "postedAt": millis("2040-02-03T09:00:05"), "body": "출금 12,000원"}},
            {"type": "notification.received", "payload": {"category": "투자", "appLabel": "증권",
             "postedAt": millis("2040-02-03T09:00:05"), "body": "12,000원"}},
        ])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["missed"][0]["alert_raw_sources"], ["argos:은행"])

    def test_balance_amounts_are_not_transaction_amounts(self):
        self.assertEqual(alert_amounts("출금 12,000원 잔액 50,000원 누적금액 90,000원"), {12000})

    def test_raw_echo_of_parsed_alert_is_not_reused(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -1900, "Pay A"),
            row("2040-02-03", "12:00:00", -1900, "Pay B"),
        ])
        fixture.collecting("2040-02-03", [{"postedAt": millis("2040-02-03T12:00:10"), "appLabel": "PAYCO",
                                           "body": "1,900원 결제"}])
        fixture.summary("2040-02-03", [alert("2040-02-03T12:00:10", 1900)])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["coverage"]["parsed"], 1)
        self.assertEqual(result["coverage"]["no_alert"], 1)

    def test_one_raw_alert_explains_only_one_row(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -1900, "Pay A"),
            row("2040-02-03", "12:00:00", -1900, "Pay B"),
        ])
        fixture.collecting("2040-02-03", [{"postedAt": millis("2040-02-03T12:00:10"), "appLabel": "PAYCO",
                                           "body": "1,900원 결제"}])
        coverage = fixture.run("2040-02-03", "2040-02-03")["coverage"]
        self.assertEqual((coverage["raw_unparsed"], coverage["no_alert"]), (1, 1))

    def test_duplicate_alerts_for_one_payment_merge(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "21:38:00", -30000, "BESTSHOP 하나카드"),
            row("2040-02-02", "22:00:00", -30000, "Bank C"),
        ])
        fixture.summary("2040-02-02", [])
        fixture.summary("2040-02-03", [alert("2040-02-03T21:38:00", 30000, "하나", merchant="카톡 표기"),
                                       alert("2040-02-03T21:38:20", 30000, "하나", merchant="앱 표기")])
        result = fixture.run("2040-02-02", "2040-02-03")
        self.assertEqual((result["coverage"]["parsed"], result["coverage"]["parsed_delayed"]), (1, 0))
        self.assertEqual(result["alert_only"], [])

    def test_inflow_never_takes_a_payment_alert(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", 5000, "Bank C", kind="수입",
                                          category="기타수입")])
        fixture.summary("2040-02-03", [alert("2040-02-03T12:00:00", 5000)])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["coverage"]["parsed"], 0)
        self.assertEqual(len(result["alert_only"]), 1)

    def test_alert_before_row_is_not_matched(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A")])
        fixture.summary("2040-02-03", [alert("2040-02-03T11:30:00", 5000)])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["coverage"]["no_alert"], 1)
        self.assertEqual(len(result["alert_only"]), 1)

    def test_maximum_matching_beats_closest_first(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -1000, "Card A"),
            row("2040-02-03", "12:06:00", -1000, "Card A"),
        ])
        fixture.summary("2040-02-03", [alert("2040-02-03T12:03:00", 1000), alert("2040-02-03T11:55:00", 1000)])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["coverage"]["parsed"], 2)
        self.assertEqual(result["alert_only"], [])

    def test_next_day_auto_payment_alert_pairs_as_delayed(self):
        fixture = Fixture(self.root, [row("2040-02-03", "19:18:00", -26550, "MG+ S 하나카드")])
        fixture.summary("2040-02-03", [])
        fixture.summary("2040-02-04", [alert("2040-02-04T11:18:00", 26550, "하나")])
        result = fixture.run("2040-02-03", "2040-02-04")
        self.assertEqual((result["coverage"]["parsed"], result["coverage"]["parsed_delayed"]), (1, 1))
        self.assertEqual(result["alert_only"], [])

    def test_delayed_needs_matching_card(self):
        fixture = Fixture(self.root, [row("2040-02-03", "19:18:00", -26550, "Bank C")])
        fixture.summary("2040-02-03", [])
        fixture.summary("2040-02-04", [alert("2040-02-04T11:18:00", 26550, "하나")])
        self.assertEqual(fixture.run("2040-02-03", "2040-02-04")["coverage"]["parsed"], 0)

    def test_delayed_needs_a_unique_candidate(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "19:18:00", -26550, "MG+ S 하나카드"),
            row("2040-02-03", "20:18:00", -26550, "MG+ S 하나카드"),
        ])
        fixture.summary("2040-02-03", [])
        fixture.summary("2040-02-04", [alert("2040-02-04T11:18:00", 26550, "하나")])
        self.assertEqual(fixture.run("2040-02-03", "2040-02-04")["coverage"]["parsed"], 0)

    def test_padded_day_alert_cannot_steal_date_only_month_end_row(self):
        fixture = Fixture(self.root, [row("2040-02-29", "00:00:00", -1500, "K-패스 체크", category="교통")])
        fixture.summary("2040-02-29", [])
        fixture.summary("2040-03-01", [alert("2040-03-01T12:00:00", 1500, "삼성")])
        result = fixture.run("2040-02-01", "2040-02-29", "2040-02")
        self.assertEqual(result["coverage"]["parsed"], 0)

    def test_boundary_alert_matches_row_just_outside_period(self):
        fixture = Fixture(self.root, [row("2040-02-02", "23:58:00", -4000, "Card A"),
                                      row("2040-02-03", "12:00:00", -800, "Card A")])
        fixture.summary("2040-02-03", [alert("2040-02-03T00:02:00", 4000)])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["alert_only"], [])
        self.assertEqual(result["coverage"]["transactions"], 1)

    def test_days_without_collection_are_no_source(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A")])
        result = fixture.run("2040-02-03", "2040-02-03")
        self.assertEqual(result["coverage"]["no_source"], 1)
        self.assertEqual(result["missed"], [])
        self.assertEqual(result["alert_sources"]["days_without_alerts"], ["2040-02-03"])

    def test_date_only_rows_match_within_the_day(self):
        fixture = Fixture(self.root, [row("2040-02-03", "00:00:00", -1500, "Transit", category="교통")])
        fixture.summary("2040-02-03", [alert("2040-02-03T18:00:00", 1500)])
        self.assertEqual(fixture.run("2040-02-03", "2040-02-03")["coverage"]["parsed"], 1)

    def test_instrument_groups_rank_missed_first(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -5000, "Card A"),
            row("2040-02-03", "13:00:00", -6000, "Transit"),
            row("2040-02-03", "14:00:00", -6100, "Transit"),
        ])
        fixture.summary("2040-02-03", [alert("2040-02-03T12:00:00", 5000)])
        groups = fixture.run("2040-02-03", "2040-02-03")["coverage"]["by_instrument"]
        self.assertEqual([group["payment_instrument"] for group in groups], ["Transit", "Card A"])
        self.assertEqual(groups[0]["no_alert"], {"count": 2, "amount": "12100"})

    def test_closed_month_includes_banksalad_totals(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A"),
                                      row("2040-01-30", "12:00:00", -800, "Card A")])
        result = fixture.run("2040-02-01", "2040-02-29", "2040-02")
        self.assertEqual(result["monthly"]["total_expense"], "5000")
        self.assertEqual(result["coverage"]["transactions"], 1)

    def test_closed_month_breakdown_tables(self):
        fixture = Fixture(self.root, [
            row("2040-02-03", "12:00:00", -5000, "Card A", description="Lunch"),
            row("2040-02-04", "12:00:00", -3000, "Pay A", description="주차장 주식회사", category="생활"),
            row("2040-02-11", "09:00:00", -30000, "Card A", description="통신요금 자동납부", category="주거/통신"),
            row("2040-01-12", "09:00:00", -28000, "Card A", description="통신요금 자동납부", category="주거/통신"),
            row("2040-02-05", "12:00:00", 9000, "Bank", description="Salary", kind="수입", category="급여"),
        ])
        (fixture.spending / "settings.json").write_text(json.dumps({
            "instrumentAliases": [{"from": "Pay A", "to": "Card A", "via": "Pay"}],
            "merchantCategories": [{"merchant": "주차장", "category": "자동차", "subcategory": "주차"}],
            "fixedCosts": [
                {"name": "통신", "merchant": "통신요금", "instrument": "Card A", "dayFrom": 10, "dayTo": 13, "variable": True},
                {"name": "구독", "merchant": "Sub", "instrument": "Card A", "dayFrom": 1, "dayTo": 3, "variable": False},
            ],
        }), encoding="utf-8")
        result = fixture.run("2040-02-01", "2040-02-29", "2040-02")
        tables = result["breakdown"]
        self.assertEqual(result["monthly"]["total_expense"], "38000")
        self.assertEqual(tables["by_instrument"], [
            {"instrument": "Card A", "count": 3, "amount": "38000", "routes": {"Pay": "3000"}}])
        categories = {group["category"]: group for group in tables["by_category"]}
        self.assertEqual(categories["자동차"]["amount"], "3000")
        self.assertEqual(categories["자동차"]["owner_override"], 1)
        self.assertNotIn("급여", categories, "income is not spending")
        fixed = {item["name"]: item for item in tables["fixed"]}
        self.assertEqual(fixed["통신"]["payments"], [{"date": "2040-02-11", "amount": "30000"}])
        self.assertEqual((fixed["통신"]["previous_amount"], fixed["통신"]["change"]), ("28000", "2000"))
        self.assertEqual(fixed["구독"]["status"], "missing")
        self.assertEqual(tables["previous_month"], "2040-01")

    def test_fixed_costs_use_day_window_and_claim_each_row_once(self):
        fixture = Fixture(self.root, [
            row("2040-02-11", "09:00:00", -30000, "Card A", description="KT 통신요금"),
            row("2040-02-20", "09:00:00", -59800, "Card A", description="KTX 코레일 통신"),
            row("2040-02-01", "09:00:00", -9900, "Card A", description="월말 구독"),
        ])
        (fixture.spending / "settings.json").write_text(json.dumps({"fixedCosts": [
            {"name": "넓은 키", "merchant": "통신", "instrument": "Card A", "dayFrom": 10, "dayTo": 13, "variable": False},
            {"name": "통신요금", "merchant": "통신요금", "instrument": "Card A", "dayFrom": 10, "dayTo": 13, "variable": True},
            {"name": "월말", "merchant": "월말 구독", "instrument": "Card A", "dayFrom": 28, "dayTo": 2, "variable": False},
        ]}), encoding="utf-8")
        fixed = {item["name"]: item for item in fixture.run("2040-02-01", "2040-02-29", "2040-02")["breakdown"]["fixed"]}
        self.assertEqual(fixed["통신요금"]["amount"], "30000", "longer key claims the row first")
        self.assertEqual(fixed["넓은 키"]["status"], "missing", "02-20 is outside 10..13 and 02-11 is taken")
        self.assertEqual(fixed["월말"]["payments"], [{"date": "2040-02-01", "amount": "9900"}], "28..2 wraps")

    def test_bad_settings_lose_tables_not_the_month(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A")])
        (fixture.spending / "settings.json").write_text(json.dumps({"instrumentAliases": [{"to": "Card B"}]}),
                                                        encoding="utf-8")
        result = fixture.run("2040-02-01", "2040-02-29", "2040-02")
        self.assertEqual(result["monthly"]["total_expense"], "5000")
        self.assertIn("KeyError", result["breakdown"]["error"])

    def test_breakdown_without_previous_month_in_export(self):
        fixture = Fixture(self.root, [row("2040-02-11", "09:00:00", -30000, "Card A", description="통신요금")],
                          folder="2040-02-01_2040-03-05")
        (fixture.spending / "settings.json").write_text(json.dumps({"fixedCosts": [
            {"name": "통신", "merchant": "통신요금", "instrument": "Card A", "dayFrom": 10, "dayTo": 13,
             "variable": False}]}), encoding="utf-8")
        tables = fixture.run("2040-02-01", "2040-02-29", "2040-02")["breakdown"]
        self.assertIsNone(tables["previous_month"])
        self.assertEqual((tables["fixed"][0]["previous_amount"], tables["fixed"][0]["change"]), (None, None))

    def test_range_check_has_no_breakdown(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A")])
        self.assertIsNone(fixture.run("2040-02-01", "2040-02-10")["breakdown"])

    def test_export_selection_requires_full_coverage(self):
        fixture = Fixture(self.root, [row("2040-02-03", "12:00:00", -5000, "Card A")],
                          folder="2040-02-01_2040-02-15")
        with self.assertRaises(ValueError):
            find_export(fixture.spending / "Banksalad", "2040-02-01", "2040-02-29")
        same_day = fixture.spending / "Banksalad" / "2040-02-01_2040-02-29"
        same_day.mkdir()
        workbook(same_day / "source.xlsx", [row("2040-02-03", "12:00:00", -5000, "Card A")])
        self.assertEqual(find_export(fixture.spending / "Banksalad", "2040-02-01", "2040-02-29"), same_day)
        with self.assertRaises(ValueError):
            find_export(fixture.spending / "Banksalad", "2040-02-01", "2040-02-29", closed_month=True)

    def test_output_cannot_land_on_inputs(self):
        spending, events = self.root / "Spending", self.root / "Events"
        self.assertTrue(safe_output(spending / "Monthly" / "2040-02.json", spending, events))
        self.assertTrue(safe_output(self.root / "elsewhere.json", spending, events))
        self.assertFalse(safe_output(spending / "2040" / "2040-02-03.summary.json", spending, events))
        self.assertFalse(safe_output(spending / "Banksalad" / "x" / "source.xlsx", spending, events))
        self.assertFalse(safe_output(events / "2040" / "2040-02-03.jsonl", spending, events))


if __name__ == "__main__":
    unittest.main()
