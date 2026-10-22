"""Self-contained regression tests using fabricated transactions and owner decisions."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook

from banksalad_audit import (
    HEADERS,
    apply_owner_decisions,
    build_report,
    load_transactions,
    mark_paired_own_account_transfers,
)


DAY = "2040-02-03"
APPROVAL = "2040-02-04"


def entry(kind="이체", category="이체", description="Synthetic transfer", amount=-137,
          instrument="Example Bank A", clock="11:00:00", memo=""):
    return (DAY, clock, kind, category, "기타", description, amount, "KRW", instrument, memo)


def workbook(path, rows):
    book = Workbook()
    sheet = book.active
    sheet.title = "가계부 내역"
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    book.save(path)
    book.close()


def decisions(source_hash, **groups):
    return {"source_file_sha256": source_hash, "approval_date": APPROVAL,
            "approved_own_transfer_rows": [], **groups}


def evidence(transaction, include_time=False, include_memo=False, include_class=False):
    fields = ("date", "description", "signed_amount", "payment_instrument")
    result = {"source_row": transaction["source_row"],
              **{f"expected_{name}": transaction[name] for name in fields}}
    if include_time:
        result["expected_time"] = transaction["time"]
    if include_memo:
        result["expected_memo"] = transaction["memo"]
    if include_class:
        result["expected_original_review_classification"] = transaction["classification"]
    return result


def final_decision_evidence(transaction):
    result = evidence(transaction, include_time=True, include_memo=True, include_class=True)
    for field in ("original_type", "original_category", "original_subcategory", "currency"):
        result[f"expected_{field}"] = transaction[field]
    return result


class BanksaladAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "synthetic.xlsx"

    def load(self, rows):
        workbook(self.source, rows)
        source_hash, transactions = load_transactions(self.source)
        return source_hash, transactions

    def report(self, rows, owner=None, spending=None):
        workbook(self.source, rows)
        decision_path = None
        if owner is not None:
            source_hash, _ = load_transactions(self.source)
            decision_path = self.root / "decisions.json"
            decision_path.write_text(json.dumps(decisions(source_hash, **owner)), encoding="utf-8")
        return build_report(self.source, spending, decision_path)

    def assert_rejected_without_mutation(self, transactions, source_hash, owner):
        before = copy.deepcopy(transactions)
        with self.assertRaises(ValueError):
            apply_owner_decisions(transactions, source_hash, owner)
        self.assertEqual(transactions, before)

    def load_final_decision_rows(self, wrong_sign_group=None):
        groups = (
            "confirmed_bank_interest_income",
            "confirmed_prior_spending_reimbursements",
            "confirmed_food_consumption_expenses",
            "confirmed_unmatched_wallet_top_ups",
        )
        amounts = (37, 89, -61, -113)
        synthetic_rows = [
            entry(description="입금 내역", amount=amounts[0], instrument="하나은행 입출금통장"),
            entry(description="Synthetic earlier purchase repayment", amount=amounts[1],
                  instrument="Example Bank B"),
            entry(category="식비", description="Fictional Picnic Stand", amount=amounts[2],
                  instrument="Example Bank C"),
            entry(description="Synthetic wallet funding", amount=amounts[3],
                  instrument="Example Wallet D"),
        ]
        if wrong_sign_group is not None:
            index = groups.index(wrong_sign_group)
            changed = list(synthetic_rows[index])
            changed[6] = -amounts[index]
            synthetic_rows[index] = tuple(changed)
        source_hash, rows = self.load(synthetic_rows)
        self.assertEqual([row["classification"] for row in rows], ["review"] * 4)
        owner_groups = {group: [final_decision_evidence(row)]
                        for group, row in zip(groups, rows)}
        owner_groups["confirmed_prior_spending_reimbursements"][0]["spending_treatment"] = (
            "offset_pending_purchase_match")
        return source_hash, rows, owner_groups

    def test_final_owner_decisions_preserve_amounts_without_inventing_links(self):
        source_hash, rows, owner_groups = self.load_final_decision_rows()
        original_rows = [(row["source_row"], row["signed_amount"]) for row in rows]
        apply_owner_decisions(rows, source_hash, decisions(source_hash, **owner_groups))

        self.assertEqual([row["classification"] for row in rows], [
            "income", "expense reimbursement received", "expense", "wallet top-up",
        ])
        self.assertEqual([row.get("income_source") for row in rows],
                         ["bank interest", None, None, None])
        self.assertEqual(rows[1]["income_treatment"], "excluded_non_income")
        self.assertEqual([row.get("spending_treatment") for row in rows], [
            None, "offset_pending_purchase_match", "consumption", "excluded_non_consumption",
        ])
        self.assertEqual([(row["source_row"], row["signed_amount"]) for row in rows],
                         original_rows)
        for row in rows:
            for link in ("candidate_related_row", "transfer_group_id", "existing_purchase_row",
                         "group_residual", "pass_through_group_id"):
                self.assertNotIn(link, row)

    def test_final_owner_decisions_reject_wrong_evidence_before_any_mutation(self):
        source_hash, rows, owner_groups = self.load_final_decision_rows()
        for group in owner_groups:
            with self.subTest(group=group):
                invalid = copy.deepcopy(owner_groups)
                invalid[group][0]["expected_original_subcategory"] = "Synthetic wrong category"
                self.assert_rejected_without_mutation(
                    rows, source_hash, decisions(source_hash, **invalid))

    def test_final_owner_decisions_reject_wrong_sign_before_any_mutation(self):
        for group in (
            "confirmed_bank_interest_income",
            "confirmed_prior_spending_reimbursements",
            "confirmed_food_consumption_expenses",
            "confirmed_unmatched_wallet_top_ups",
        ):
            with self.subTest(group=group):
                source_hash, rows, owner_groups = self.load_final_decision_rows(group)
                self.assert_rejected_without_mutation(
                    rows, source_hash, decisions(source_hash, **owner_groups))

    def test_final_owner_decisions_reject_row_reused_across_groups(self):
        source_hash, rows, owner_groups = self.load_final_decision_rows()
        owner_groups["confirmed_prior_spending_reimbursements"][0] = {
            **final_decision_evidence(rows[0]),
            "spending_treatment": "offset_pending_purchase_match",
        }
        self.assert_rejected_without_mutation(
            rows, source_hash, decisions(source_hash, **owner_groups))

    def test_final_owner_decisions_reject_wrong_reimbursement_treatment(self):
        source_hash, rows, owner_groups = self.load_final_decision_rows()
        owner_groups["confirmed_prior_spending_reimbursements"][0]["spending_treatment"] = (
            "excluded_non_consumption")
        self.assert_rejected_without_mutation(
            rows, source_hash, decisions(source_hash, **owner_groups))

    def test_owner_approved_transfer_and_destination_preserve_other_rows(self):
        source_hash, rows = self.load([
            entry(category="내계좌이체", description="Synthetic account move"),
            entry(kind="지출", category="식비", description="Fictional Cafe", amount=-53),
        ])
        owner = decisions(source_hash, approved_own_transfer_rows=[2],
                          confirmed_destinations=[{"source_row": 2,
                                                   "destination_account": "Example Account B",
                                                   "confirmation_date": APPROVAL}])
        untouched = copy.deepcopy(rows[1])
        apply_owner_decisions(rows, source_hash, owner)
        self.assertEqual(rows[0]["classification"], "own-account transfer")
        self.assertEqual(rows[0]["destination_account"], "Example Account B")
        self.assertEqual(rows[0]["signed_amount"], "-137")
        self.assertEqual(rows[1], untouched)

    def test_owner_decisions_reject_hash_duplicate_and_evidence_conflicts(self):
        source_hash, rows = self.load([
            entry(category="내계좌이체"),
            entry(description="Synthetic pending transfer", amount=-41),
        ])
        valid = decisions(source_hash, approved_own_transfer_rows=[2])
        for change in (
            {"source_file_sha256": "wrong"},
            {"approved_own_transfer_rows": [2, 2]},
            {"confirmed_review_decisions": [{"source_row": 3,
                "expected_description": "Wrong description", "expected_signed_amount": "-41",
                "expected_payment_instrument": "Example Bank A",
                "classification": "own-account transfer"}]},
            {"confirmed_destinations": [{"source_row": 3,
                "destination_account": "Example Account B", "confirmation_date": APPROVAL}]},
        ):
            with self.subTest(change=change):
                owner = {**valid, **change}
                self.assert_rejected_without_mutation(rows, source_hash, owner)

    def test_bank_legs_pair_only_with_opposite_amounts_and_distinct_instruments(self):
        _, rows = self.load([
            entry(category="내계좌이체", amount=-71, instrument="Example Bank A"),
            entry(category="내계좌이체", amount=71, instrument="Example Bank B"),
            entry(category="내계좌이체", amount=-83, instrument="Example Bank A"),
            entry(category="내계좌이체", amount=83, instrument="Example Bank A"),
        ])
        mark_paired_own_account_transfers(rows)
        self.assertEqual([row["classification"] for row in rows],
                         ["own-account transfer", "own-account transfer", "review", "review"])

    def test_pass_through_signed_residual_and_row_membership(self):
        source_hash, rows = self.load([
            entry(description="Synthetic group charge", amount=-157),
            entry(description="Synthetic reimbursement", amount=149),
        ])
        legs = [{**evidence(row, include_memo=True, include_class=True), "role": role}
                for row, role in zip(rows, ("charge", "receipt"))]
        group = {"group_id": "synthetic-group", "expected_date": DAY,
                 "expected_residual": "-8",
                 "relation_status": "owner_confirmed_purchase_reimbursement_not_exact_amount",
                 "legs": legs}
        owner = decisions(source_hash, confirmed_third_party_purchase_pass_throughs=[group])
        apply_owner_decisions(rows, source_hash, owner)
        self.assertEqual([row["classification"] for row in rows],
                         ["third-party purchase pass-through"] * 2)
        self.assertEqual([row["signed_amount"] for row in rows], ["-157", "149"])
        self.assertEqual(rows[0]["group_residual"], "-8")
        self.assertEqual(rows[1]["income_treatment"], "excluded_non_income")
        report = self.report([
            entry(description="Synthetic group charge", amount=-157),
            entry(description="Synthetic reimbursement", amount=149),
        ], {"confirmed_third_party_purchase_pass_throughs": [group]})
        self.assertEqual(report["third_party_purchase_pass_throughs"]["aggregate_signed_residual"], "-8")
        self.assertEqual(report["coverage"]["transaction_rows"], 2)

    def test_pass_through_rejects_residual_evidence_and_reused_row(self):
        source_hash, rows = self.load([
            entry(description="Synthetic group charge", amount=-157),
            entry(description="Synthetic reimbursement", amount=149),
        ])
        legs = [{**evidence(row, include_memo=True, include_class=True), "role": role}
                for row, role in zip(rows, ("charge", "receipt"))]
        group = {"group_id": "synthetic-group", "expected_date": DAY,
                 "expected_residual": "-8",
                 "relation_status": "owner_confirmed_purchase_reimbursement_not_exact_amount",
                 "legs": legs}
        variants = [
            {**group, "expected_residual": "0"},
            {**group, "legs": [{**legs[0], "expected_description": "Fabricated mismatch"}, legs[1]]},
            {**group, "legs": [legs[0], legs[0]]},
        ]
        for invalid in variants:
            with self.subTest(invalid=invalid):
                self.assert_rejected_without_mutation(rows, source_hash, decisions(
                    source_hash, confirmed_third_party_purchase_pass_throughs=[invalid]))

    def test_payment_link_retains_existing_purchase_and_receipt_approval(self):
        source_hash, rows = self.load([
            entry(category="내계좌이체", description="카카오페이", amount=-97,
                  instrument="하나은행 입출금통장", clock="11:01:00"),
            entry(category="내계좌이체", description="Synthetic wallet receipt", amount=97,
                  instrument="카카오페이 머니", clock="11:01:25"),
            entry(kind="지출", category="식비", description="Fictional Noodle Shop",
                  amount=-73, instrument="카카오페이 머니", clock="11:01:40"),
        ])
        payment = {"group_id": "synthetic-payment", "bank_outflow": evidence(rows[0], True, True, True),
                   "wallet_receipt": evidence(rows[1], True, True, True),
                   "purchase": evidence(rows[2], True, True, True)}
        owner = decisions(source_hash, approved_own_transfer_rows=[3],
                          confirmed_kakao_payment_top_ups=[payment])
        apply_owner_decisions(rows, source_hash, owner)
        self.assertEqual(rows[0]["classification"], "wallet top-up for purchase")
        self.assertEqual(rows[1]["classification"], "own-account transfer")
        self.assertEqual(rows[2]["classification"], "expense")
        self.assertEqual(rows[0]["existing_purchase_row"], 4)
        self.assertEqual(rows[2]["signed_amount"], "-73")

    def test_payment_link_rejects_wrong_receipt_or_unapproved_receipt(self):
        source_hash, rows = self.load([
            entry(category="내계좌이체", description="카카오페이", amount=-97,
                  instrument="하나은행 입출금통장", clock="11:01:00"),
            entry(category="내계좌이체", description="Synthetic wallet receipt", amount=97,
                  instrument="카카오페이 머니", clock="11:01:25"),
            entry(kind="지출", category="식비", description="Fictional Noodle Shop",
                  amount=-73, instrument="카카오페이 머니", clock="11:01:40"),
        ])
        payment = {"group_id": "synthetic-payment", "bank_outflow": evidence(rows[0], True, True, True),
                   "wallet_receipt": evidence(rows[1], True, True, True),
                   "purchase": evidence(rows[2], True, True, True)}
        self.assert_rejected_without_mutation(rows, source_hash, decisions(
            source_hash, confirmed_kakao_payment_top_ups=[payment]))
        payment["wallet_receipt"]["expected_signed_amount"] = "98"
        self.assert_rejected_without_mutation(rows, source_hash, decisions(
            source_hash, approved_own_transfer_rows=[3], confirmed_kakao_payment_top_ups=[payment]))

    def test_exact_duplicates_are_reported_without_dropping_rows(self):
        duplicate = entry(kind="지출", category="교통", description="Synthetic tram", amount=-29,
                          instrument="Example Card", clock="00:00:00")
        report = self.report([duplicate, duplicate])
        self.assertEqual(report["coverage"]["transaction_rows"], 2)
        self.assertEqual(report["coverage"]["exact_duplicate_groups"], 1)
        self.assertEqual(report["exact_duplicate_groups"][0]["source_rows"], [2, 3])
        self.assertTrue(report["exact_duplicate_groups"][0]["midnight_transit"])
        self.assertEqual(report["transactions"][0]["exact_duplicate_rows"], [3])

    def test_spending_overlap_uses_only_summary_and_does_not_drop_rows(self):
        spending = self.root / "summaries"
        spending.mkdir()
        rows = [entry(kind="지출", category="식비", description="Fictional Bakery",
                      amount=-43, instrument="신한 Example Card")]
        payload = {"date": DAY, "entries": [{"status": "expense", "amount": 43,
                   "merchant": "Fictional Bakery", "card": "신한"}]}
        (spending / "day.summary.json").write_text(json.dumps(payload), encoding="utf-8")
        (spending / "ignored.json").write_text(json.dumps(payload), encoding="utf-8")
        report = self.report(rows, spending=spending)
        self.assertEqual(len(report["spending_overlap_candidates"]), 1)
        self.assertEqual(report["spending_overlap_candidates"][0]["tier"], "high")
        self.assertEqual(report["spending_overlap_candidates"][0]["source_row"], 2)
        self.assertEqual(report["coverage"]["transaction_rows"], 1)

    def test_spending_overlap_ambiguous_amount_is_not_auto_matched(self):
        spending = self.root / "summaries"
        spending.mkdir()
        (spending / "day.summary.json").write_text(json.dumps({"date": DAY, "entries": [
            {"status": "expense", "amount": 43, "merchant": "Unrelated Shop", "card": "신한"}]}),
            encoding="utf-8")
        report = self.report([
            entry(kind="지출", category="식비", description="Fictional Bakery",
                  amount=-43, instrument="신한 Example Card"),
            entry(kind="지출", category="식비", description="Fictional Grocer",
                  amount=-43, instrument="신한 Example Card"),
        ], spending=spending)
        candidate = report["spending_overlap_candidates"][0]
        self.assertIsNone(candidate["tier"])
        self.assertEqual(candidate["candidate_rows"], [2, 3])
        self.assertNotIn("source_row", candidate)

    def test_cli_requires_output_and_protects_inputs_and_stdout(self):
        workbook(self.source, [entry(kind="지출", category="식비",
                                     description="Fictional Private Merchant", amount=-43)])
        script = Path(__file__).with_name("banksalad_audit.py")
        missing = subprocess.run([sys.executable, "-B", str(script), str(self.source)],
                                 capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.root / "synthetic.json").exists())
        protected = subprocess.run([sys.executable, "-B", str(script), str(self.source),
                                    "--output", str(self.source)], capture_output=True, text=True)
        self.assertNotEqual(protected.returncode, 0)
        output = self.root / "report.json"
        valid = subprocess.run([sys.executable, "-B", str(script), str(self.source),
                                "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertTrue(output.exists())
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["coverage"]["transaction_rows"], 1)
        self.assertNotIn("Fictional Private Merchant", valid.stdout + valid.stderr)
        self.assertNotIn("-43", valid.stdout + valid.stderr)

    def test_cli_rejects_invalid_decisions_without_writing_report(self):
        workbook(self.source, [entry(category="내계좌이체")])
        owner = self.root / "owner.json"
        owner.write_text(json.dumps(decisions("wrong", approved_own_transfer_rows=[2])), encoding="utf-8")
        output = self.root / "report.json"
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("banksalad_audit.py")),
                                 str(self.source), "--owner-decisions", str(owner), "--output", str(output)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
