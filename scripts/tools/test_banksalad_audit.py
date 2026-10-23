"""Self-contained regression tests using fabricated transactions and owner decisions."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import Workbook
import banksalad_audit

from banksalad_audit import (
    HEADERS,
    apply_owner_decisions,
    build_report,
    load_transactions,
    mark_paired_own_account_transfers,
    monthly_breakdown,
)


DAY = "2040-02-03"
APPROVAL = "2040-02-04"


def entry(kind="이체", category="이체", description="Synthetic transfer", amount=-137,
          instrument="Example Bank A", clock="11:00:00", memo="", currency="KRW"):
    return (DAY, clock, kind, category, "기타", description, amount, currency, instrument, memo)


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


def offset_evidence(transaction):
    return {"source_row": transaction["source_row"],
            **{f"expected_{field}": transaction[field] for field in
               ("date", "time", "signed_amount", "description",
                "payment_instrument", "original_type")}}


class BanksaladAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = (self.root / "Spending" / "Banksalad"
                       / "2040-02-01_2040-02-29" / "source.xlsx")
        self.source.parent.mkdir(parents=True)

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

    def test_confirmed_offsets_keep_gross_and_partial_residual(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-11000, description="Clinic"),
            entry(kind="지출", category="식비", amount=10810, description="Clinic"),
            entry(kind="지출", category="식비", amount=-522, description="Group meal"),
            entry(amount=446, description="Group settlement"),
        ])
        group_decision = {**evidence(rows[3], include_memo=True, include_class=True),
                          "owner_context": "group-expense settlement",
                          "spending_treatment": "offset_pending_purchase_match"}
        owner = decisions(source_hash,
                          confirmed_group_expense_reimbursements=[group_decision],
                          confirmed_refund_purchase_links=[{
                              "refund": offset_evidence(rows[1]),
                              "purchase": offset_evidence(rows[0])}],
                          confirmed_group_reimbursement_links=[{
                              "reimbursements": [offset_evidence(rows[3])],
                              "purchases": [offset_evidence(rows[2])],
                              "expected_owner_share": "76"}])
        apply_owner_decisions(rows, source_hash, owner)
        month = monthly_breakdown(rows)[0]
        self.assertEqual(month["total_expense"], "11522")
        self.assertEqual(month["direct_refund_offset"], "10810")
        self.assertEqual(month["group_reimbursement_offset"], "446")
        self.assertEqual(month["net_expense"], "266")
        self.assertEqual(rows[0]["signed_amount"], "-11000")
        self.assertEqual(rows[0]["offset_credit_rows"], [3])
        self.assertEqual(rows[2]["offset_credit_rows"], [5])

    def test_cross_month_refund_offsets_receipt_month_and_allows_negative_net(self):
        purchase = ("2040-01-30", *entry(kind="지출", category="식비", amount=-100,
                                        description="Clinic")[1:])
        refund = ("2040-02-03", *entry(kind="지출", category="식비", amount=100,
                                      description="Clinic", clock="12:00:00")[1:])
        source_hash, rows = self.load([purchase, refund])
        owner = decisions(source_hash, confirmed_refund_purchase_links=[{
            "refund": offset_evidence(rows[1]), "purchase": offset_evidence(rows[0])}])
        apply_owner_decisions(rows, source_hash, owner)
        january, february = monthly_breakdown(rows)
        self.assertEqual(january["net_expense"], "100")
        self.assertEqual(february["total_expense"], "0")
        self.assertEqual(february["direct_refund_offset"], "100")
        self.assertEqual(february["net_expense"], "-100")
        self.assertEqual(february["net_expense_status"], "confirmed_offsets_only")

    def test_two_partial_refunds_accumulate_and_over_refund_is_rejected(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-100, description="Clinic"),
            entry(kind="지출", category="식비", amount=40, description="Clinic",
                  clock="12:00:00"),
            entry(kind="지출", category="식비", amount=60, description="Clinic",
                  clock="13:00:00"),
        ])
        links = [{"refund": offset_evidence(refund), "purchase": offset_evidence(rows[0])}
                 for refund in rows[1:]]
        apply_owner_decisions(rows, source_hash,
                              decisions(source_hash, confirmed_refund_purchase_links=links))
        self.assertEqual(rows[0]["offset_credit_rows"], [3, 4])
        self.assertEqual(monthly_breakdown(rows)[0]["net_expense"], "0")
        source_hash, too_much = self.load([
            entry(kind="지출", category="식비", amount=-100, description="Clinic"),
            entry(kind="지출", category="식비", amount=40, description="Clinic",
                  clock="12:00:00"),
            entry(kind="지출", category="식비", amount=61, description="Clinic",
                  clock="13:00:00"),
        ])
        over_links = [{"refund": offset_evidence(refund),
                       "purchase": offset_evidence(too_much[0])} for refund in too_much[1:]]
        self.assert_rejected_without_mutation(
            too_much, source_hash,
            decisions(source_hash, confirmed_refund_purchase_links=over_links))

    def test_refund_link_rejects_mismatched_and_non_krw_currency(self):
        for purchase_currency, refund_currency in (("KRW", "USD"), ("USD", "KRW"),
                                                   ("USD", "USD")):
            with self.subTest(purchase_currency=purchase_currency,
                              refund_currency=refund_currency):
                source_hash, rows = self.load([
                    entry(kind="지출", category="식비", amount=-100, description="Clinic",
                          currency=purchase_currency),
                    entry(kind="지출", category="식비", amount=100, description="Clinic",
                          currency=refund_currency, clock="12:00:00"),
                ])
                self.assert_rejected_without_mutation(rows, source_hash, decisions(
                    source_hash, confirmed_refund_purchase_links=[{
                        "refund": offset_evidence(rows[1]),
                        "purchase": offset_evidence(rows[0])}]))

    def test_group_link_rejects_mismatched_and_non_krw_currency(self):
        for purchase_currency, reimbursement_currency in (("KRW", "USD"), ("USD", "KRW"),
                                                          ("USD", "USD")):
            with self.subTest(purchase_currency=purchase_currency,
                              reimbursement_currency=reimbursement_currency):
                source_hash, rows = self.load([
                    entry(kind="지출", category="식비", amount=-100,
                          currency=purchase_currency),
                    entry(amount=60, currency=reimbursement_currency),
                ])
                receipt = {**evidence(rows[1], include_memo=True, include_class=True),
                           "owner_context": "group-expense settlement",
                           "spending_treatment": "offset_pending_purchase_match"}
                self.assert_rejected_without_mutation(rows, source_hash, decisions(
                    source_hash, confirmed_group_expense_reimbursements=[receipt],
                    confirmed_group_reimbursement_links=[{
                        "reimbursements": [offset_evidence(rows[1])],
                        "purchases": [offset_evidence(rows[0])],
                        "expected_owner_share": "40"}]))

    def test_refund_link_can_use_kept_duplicate_purchase_only(self):
        purchase = entry(kind="지출", category="식비", amount=-100,
                         description="Clinic")
        source_hash, rows = self.load([
            purchase, purchase,
            entry(kind="지출", category="식비", amount=100,
                  description="Clinic", clock="12:00:00"),
        ])
        pair = {"keep_source_row": rows[0]["source_row"],
                "exclude_source_row": rows[1]["source_row"],
                "approval_date": APPROVAL, "treatment": "count_first_once"}
        owner = decisions(source_hash, confirmed_exact_duplicate_pairs=[pair],
                          confirmed_refund_purchase_links=[{
                              "refund": offset_evidence(rows[2]),
                              "purchase": offset_evidence(rows[0])}])
        apply_owner_decisions(rows, source_hash, owner)
        self.assertEqual(rows[0]["offset_credit_rows"], [rows[2]["source_row"]])
        self.assertEqual(rows[1]["aggregation_status"], "excluded_owner_confirmed_duplicate")
        self.assertEqual(monthly_breakdown(rows)[0]["net_expense"], "0")

        source_hash, rejected_rows = self.load([
            purchase, purchase,
            entry(kind="지출", category="식비", amount=100,
                  description="Clinic", clock="12:00:00"),
        ])
        rejected_owner = decisions(source_hash, confirmed_exact_duplicate_pairs=[pair],
                                   confirmed_refund_purchase_links=[{
                                       "refund": offset_evidence(rejected_rows[2]),
                                       "purchase": offset_evidence(rejected_rows[1])}])
        self.assert_rejected_without_mutation(rejected_rows, source_hash, rejected_owner)

    def test_group_link_can_use_kept_duplicate_reimbursement_only(self):
        purchase = entry(kind="지출", category="식비", amount=-100)
        reimbursement = entry(amount=60, description="Group settlement")
        source_hash, rows = self.load([purchase, reimbursement, reimbursement])
        pair = {"keep_source_row": rows[1]["source_row"],
                "exclude_source_row": rows[2]["source_row"],
                "approval_date": APPROVAL, "treatment": "count_first_once"}

        def owner_for(loaded, reimbursement_index):
            receipt = {**evidence(loaded[reimbursement_index], include_memo=True,
                                  include_class=True),
                       "owner_context": "group-expense settlement",
                       "spending_treatment": "offset_pending_purchase_match"}
            return decisions(source_hash, confirmed_exact_duplicate_pairs=[pair],
                             confirmed_group_expense_reimbursements=[receipt],
                             confirmed_group_reimbursement_links=[{
                                 "reimbursements": [offset_evidence(loaded[reimbursement_index])],
                                 "purchases": [offset_evidence(loaded[0])],
                                 "expected_owner_share": "40"}])

        apply_owner_decisions(rows, source_hash, owner_for(rows, 1))
        self.assertEqual(rows[0]["offset_credit_rows"], [rows[1]["source_row"]])
        self.assertEqual(monthly_breakdown(rows)[0]["net_expense"], "40")

        source_hash, rejected_rows = self.load([purchase, reimbursement, reimbursement])
        self.assert_rejected_without_mutation(rejected_rows, source_hash,
                                              owner_for(rejected_rows, 2))

    def test_pending_reimbursements_and_unresolved_reversals_remain_visible(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-100, description="Meal"),
            entry(amount=60, description="Group settlement"),
            entry(kind="지출", category="식비", amount=15, description="Unknown refund"),
            entry(kind="지출", category="식비", amount=-10, description="결제취소 pending"),
        ])
        pending = {**evidence(rows[1], include_memo=True, include_class=True),
                   "owner_context": "group-expense settlement",
                   "spending_treatment": "offset_pending_purchase_match"}
        apply_owner_decisions(rows, source_hash, decisions(
            source_hash, confirmed_group_expense_reimbursements=[pending]))
        month = monthly_breakdown(rows)[0]
        self.assertEqual(month["pending_reimbursement_amount"], "60")
        self.assertEqual(month["pending_reimbursement_rows"], [3])
        self.assertEqual(month["unresolved_positive_refund_amount"], "15")
        self.assertEqual(month["unresolved_positive_refund_rows"], [4])
        self.assertEqual(month["unresolved_negative_cancellation_amount"], "10")
        self.assertEqual(month["unresolved_negative_cancellation_rows"], [5])
        self.assertEqual(month["net_expense"], "100")
        self.assertEqual(month["net_expense_status"], "confirmed_offsets_only_pending_links")

    def test_offset_links_fail_closed_on_evidence_and_reuse(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-100),
            entry(kind="지출", category="식비", amount=90),
            entry(kind="지출", category="식비", amount=-100,
                  description="Different new purchase"),
        ])
        link = {"refund": offset_evidence(rows[1]), "purchase": offset_evidence(rows[0])}
        for change in (
            {"source_file_sha256": "wrong"},
            {"confirmed_refund_purchase_links": [{**link, "refund": {
                **link["refund"], "expected_signed_amount": "91"}}]},
            {"confirmed_refund_purchase_links": [link, link]},
            {"confirmed_refund_purchase_links": [{**link, "purchase": offset_evidence(rows[1])}]},
            {"confirmed_refund_purchase_links": [{**link, "purchase": offset_evidence(rows[2])}]},
            {"confirmed_refund_purchase_links": [{**link, "purchase": {
                **link["purchase"], "expected_date": "2040-02-02"}}]},
        ):
            with self.subTest(change=change):
                self.assert_rejected_without_mutation(
                    rows, source_hash, {**decisions(source_hash),
                                        "confirmed_refund_purchase_links": [link], **change})

    def test_group_offset_rejects_reused_receipt_and_wrong_residual(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-100),
            entry(amount=60),
        ])
        receipt = {**evidence(rows[1], include_memo=True, include_class=True),
                   "owner_context": "group-expense settlement",
                   "spending_treatment": "offset_pending_purchase_match"}
        group = {"reimbursements": [offset_evidence(rows[1])],
                 "purchases": [offset_evidence(rows[0])],
                 "expected_owner_share": "40"}
        base = decisions(source_hash, confirmed_group_expense_reimbursements=[receipt])
        for invalid in ({**group, "expected_owner_share": "39"},
                        {**group, "reimbursements": [offset_evidence(rows[1])] * 2},
                        {**group, "purchases": [offset_evidence(rows[1])]}):
            with self.subTest(invalid=invalid):
                self.assert_rejected_without_mutation(
                    rows, source_hash,
                    {**base, "confirmed_group_reimbursement_links": [invalid]})

    def test_refunded_purchase_cannot_also_back_group_reimbursement(self):
        source_hash, rows = self.load([
            entry(kind="지출", category="식비", amount=-100, description="Meal"),
            entry(kind="지출", category="식비", amount=40, description="Meal",
                  clock="12:00:00"),
            entry(amount=60, description="Group settlement"),
        ])
        receipt = {**evidence(rows[2], include_memo=True, include_class=True),
                   "owner_context": "group-expense settlement",
                   "spending_treatment": "offset_pending_purchase_match"}
        self.assert_rejected_without_mutation(rows, source_hash, decisions(
            source_hash,
            confirmed_group_expense_reimbursements=[receipt],
            confirmed_refund_purchase_links=[{
                "refund": offset_evidence(rows[1]), "purchase": offset_evidence(rows[0])}],
            confirmed_group_reimbursement_links=[{
                "reimbursements": [offset_evidence(rows[2])],
                "purchases": [offset_evidence(rows[0])],
                "expected_owner_share": "40"}]))

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

    def test_approved_duplicates_count_once_without_collapsing_transit(self):
        transfer = entry(category="내계좌이체", description="Synthetic account move", amount=-137)
        deposit = entry(kind="수입", category="기타수입", description="Synthetic deposit", amount=29)
        transit = list(entry(kind="지출", category="교통", description="Synthetic tram", amount=-11,
                             clock="00:00:00"))
        transit[4] = "대중교통"
        transit = tuple(transit)
        rows = [transfer, transfer, deposit, deposit, transit, transit]
        source_hash, _ = self.load(rows)
        pairs = [{"keep_source_row": first, "exclude_source_row": second,
                  "approval_date": APPROVAL, "treatment": "count_first_once"}
                 for first, second in ((2, 3), (4, 5))]
        report = self.report(rows, {"approved_own_transfer_rows": [2, 3],
                                    "confirmed_exact_duplicate_pairs": pairs})
        self.assertEqual(report["coverage"]["transaction_rows"], 6)
        self.assertEqual(report["coverage"]["effective_aggregation_rows"], 4)
        self.assertEqual(report["coverage"]["excluded_approved_duplicate_rows"], 2)
        self.assertEqual(report["coverage"]["review_rows"], 0)
        self.assertEqual([item["aggregation_status"] for item in report["transactions"]], [
            "included_owner_confirmed_duplicate", "excluded_owner_confirmed_duplicate",
            "included_owner_confirmed_duplicate", "excluded_owner_confirmed_duplicate",
            "included", "included",
        ])
        self.assertEqual(report["transactions"][1]["aggregation_decision"], {
            "paired_source_row": 2, "approval_date": APPROVAL, "treatment": "count_first_once",
        })
        self.assertEqual(report["coverage"]["raw_classification_signed_totals"]["income"], "58")
        self.assertEqual(report["coverage"]["classification_signed_totals"],
                         report["coverage"]["raw_classification_signed_totals"])
        self.assertEqual(report["category_totals"], report["raw_category_totals"])
        self.assertEqual(report["coverage"]["effective_classification_signed_totals"]["income"], "29")
        self.assertEqual(report["coverage"]["raw_classification_signed_totals"]["own-account transfer"], "-274")
        self.assertEqual(report["coverage"]["effective_classification_signed_totals"]["own-account transfer"], "-137")
        self.assertEqual(report["coverage"]["effective_classification_signed_totals"]["expense"], "-22")
        self.assertEqual(len(report["reconciliation_candidates"]["transit"]), 1)
        self.assertEqual(report["reconciliation_candidates"]["transit"][0]["status"],
                         "candidate_only_no_auto_drop")
        self.assertEqual(source_hash, report["source_file_sha256"])

    def test_approved_source_uses_validated_duplicate_pairs_when_field_absent(self):
        rows = [entry(kind="지출", category="식비", description="Meal", amount=-100)] * 2
        source_hash, loaded = self.load(rows)
        approved_source = {"APPROVED_DUPLICATE_PAIRS": ((2, 3),),
                           "APPROVED_DUPLICATE_DATE": APPROVAL,
                           "APPROVED_UNVERIFIED_KAKAO_ROWS": (),
                           "APPROVED_UNVERIFIED_KAKAO_TOTAL": 0}
        with patch.multiple(banksalad_audit, APPROVED_SOURCE_SHA256=source_hash,
                            **approved_source):
            report = self.report(rows, {})
            self.assertEqual(report["coverage"]["excluded_approved_duplicate_rows"], 1)
            self.assertEqual(report["monthly_breakdown"][0]["total_expense"], "100")
            self.assertEqual(report["transactions"][1]["aggregation_status"],
                             "excluded_owner_confirmed_duplicate")
            self.assert_rejected_without_mutation(
                loaded, source_hash, decisions(source_hash, confirmed_exact_duplicate_pairs=[]))
            changed = list(rows[1])
            changed[9] = "different memo"
            changed_hash, changed_rows = self.load([rows[0], tuple(changed)])
        with patch.multiple(banksalad_audit, APPROVED_SOURCE_SHA256=changed_hash,
                            **approved_source):
            self.assert_rejected_without_mutation(changed_rows, changed_hash,
                                                  decisions(changed_hash))

    def test_five_unverified_kakao_outflows_count_as_expense_without_destination(self):
        amounts = (-25000, -200000, -50000, -25000, -100000)
        rows = [entry(description="카카오페이", amount=amount,
                      instrument="하나은행 입출금통장", clock=f"{hour:02}:00:00")
                for hour, amount in enumerate(amounts, start=10)]
        source_hash, loaded = self.load(rows)
        group = [evidence(item, include_time=True, include_memo=True, include_class=True)
                 for item in loaded]
        with (patch.object(banksalad_audit, "APPROVED_SOURCE_SHA256", source_hash),
              patch.object(banksalad_audit, "APPROVED_UNVERIFIED_KAKAO_ROWS", tuple(range(2, 7))),
              patch.object(banksalad_audit, "APPROVED_DUPLICATE_PAIRS", ())):
            self.assert_rejected_without_mutation(
                loaded, source_hash, decisions(source_hash,
                                               unverified_kakao_transfers=group[:-1]))
            report = self.report(rows, {"unverified_kakao_transfers": group})
        self.assertEqual([item["classification"] for item in report["transactions"]],
                         ["unverified-destination transfer"] * 5)
        for item in report["transactions"]:
            self.assertEqual(item["destination_status"], "unverified")
            self.assertEqual(item["spending_treatment"], "unverified_usage_expense")
            self.assertEqual(item["expense_label"], "사용처 미확인 지출")
            self.assertNotIn("destination_account", item)
        month = report["monthly_breakdown"][0]
        self.assertEqual(month["total_expense"], "400000")
        self.assertEqual(month["unverified_usage_spending"], "400000")
        self.assertEqual(month["everyday_expense"], "0")

    def test_monthly_breakdown_separates_evidenced_items_without_netting_refunds(self):
        rows = [
            entry(kind="지출", category="식비", description="Meal", amount=-100),
            entry(kind="지출", category="식비", description="Meal", amount=-100),
            entry(kind="지출", category="금융", description="Tax", amount=-70, memo="주민세"),
            entry(kind="지출", category="금융", description="Unknown gateway", amount=-30),
            entry(kind="지출", category="뷰티/미용", description="Salon", amount=-50,
                  memo="미용실 선불"),
            entry(kind="지출", category="식비", description="Refund", amount=10),
            entry(kind="수입", category="급여", description="전자급여", amount=300),
            entry(kind="수입", category="급여", description="전자연차보상", amount=20),
            entry(kind="수입", category="상여금", description="전자TAI", amount=40),
            entry(category="카드대금", description="Card settlement", amount=-500),
            entry(description="주택청약", amount=-600),
            entry(description="업비트 입금", amount=-700),
            entry(category="내계좌이체", description="Owner account", amount=-800),
        ]
        rows = [tuple((*row[:4], "세금/과태료", *row[5:])) if index in (2, 3) else row
                for index, row in enumerate(rows)]
        pair = {"keep_source_row": 2, "exclude_source_row": 3,
                "approval_date": APPROVAL, "treatment": "count_first_once"}
        report = self.report(rows, {"confirmed_exact_duplicate_pairs": [pair],
                                    "approved_own_transfer_rows": [14]})
        month = report["monthly_breakdown"][0]
        self.assertEqual({key: month[key] for key in (
            "total_expense", "everyday_expense", "one_off_tax", "confirmed_prepayment",
            "unverified_usage_spending", "total_income", "recurring_salary_income",
            "bonus_income", "other_income")}, {
                "total_expense": "250", "everyday_expense": "100", "one_off_tax": "100",
                "confirmed_prepayment": "50", "unverified_usage_spending": "0",
                "total_income": "360", "recurring_salary_income": "300", "bonus_income": "40",
                "other_income": "20",
            })
        self.assertEqual(month["review_rows"], [5])
        self.assertFalse(month["boundary_month_partial"])

    def test_monthly_breakdown_memo_less_tax_penalty_category_needs_review(self):
        def expense(category, subcategory, amount, memo=""):
            row = entry(kind="지출", category=category, description="Synthetic expense",
                        amount=amount, memo=memo)
            return ("2026-09-11", *row[1:4], subcategory, *row[5:])

        _, transactions = self.load([
            expense("금융", "세금/과태료", -169720),
            expense("식비", "세금/과태료", -40, "주민세"),
            expense("금융", "기타", -40, "주민세"),
        ])
        transactions[0]["source_row"] = 191
        month = monthly_breakdown(transactions)[0]
        self.assertEqual(month["total_expense"], "169800")
        self.assertEqual(month["one_off_tax"], "169720")
        self.assertEqual(month["everyday_expense"], "80")
        self.assertEqual(month["review_rows"], [191])

    def test_monthly_breakdown_prepayment_requires_exact_source_evidence(self):
        def expense(category, subcategory, description, memo):
            row = entry(kind="지출", category=category, description=description,
                        amount=-10, memo=memo)
            return (*row[:4], subcategory, *row[5:])

        prepaid = [
            expense("의료/건강", "운동", "국가대표 복싱센터 송도2호점", "복싱 6개월 주 5회"),
            expense("의료/건강", "운동", "국가대표 복싱센터 송도2호점", "복싱 6개월 주 5회"),
            expense("문화/여가", "운동", "국가대표 복싱센터", "3개월"),
            expense("온라인쇼핑", "서비스구독", "AMAZON BD", "유튜브 인도 6개월"),
            expense("온라인쇼핑", "서비스구독", "AMAZON BD", "유튜브 3개월"),
            expense("교육/학습", "미분류", "고래수학교습소", "미네 수학 7월, 8월"),
            expense("뷰티/미용", "기타", "Salon", "미용실 선불"),
        ]
        everyday = [
            expense("문화/여가", "운동", "국가대표 복싱센터",
                    "복싱 1개월(24만원), 글러브"),
            expense("의료/건강", "운동", "국가대표 복싱센터 송도2호점",
                    "복싱 6개월 주 5회 + 캠프"),
            expense("온라인쇼핑", "서비스구독", "AMAZON BD", "유튜브 3개월 + 항공"),
            expense("온라인쇼핑", "서비스구독", "AMAZON BD", "유튜브 인도 6개월 / 캠프"),
            expense("온라인쇼핑", "일반쇼핑", "AMAZON BD", "유튜브 3개월"),
            expense("온라인쇼핑", "서비스구독", "ANOTHER MERCHANT", "유튜브 3개월"),
            expense("문화/여가", "운동", "국가대표 복싱센터 송도2호점", "3개월"),
            expense("여행", "항공", "Airfare", "3개월"),
        ]
        report = self.report(prepaid + everyday)
        self.assertTrue(all(item["classification"] == "expense"
                            for item in report["transactions"]))
        month = report["monthly_breakdown"][0]
        self.assertEqual(month["total_expense"], "150")
        self.assertEqual(month["confirmed_prepayment"], "70")
        self.assertEqual(month["everyday_expense"], "80")
        self.assertEqual(month["one_off_tax"], "0")
        self.assertEqual(month["unverified_usage_spending"], "0")

    def test_monthly_breakdown_uses_export_coverage_not_transaction_edges(self):
        self.source = (self.root / "Spending" / "Banksalad"
                       / "2025-10-21_2026-10-21" / "source.xlsx")
        self.source.parent.mkdir(parents=True)
        rows = []
        for month in ("2025-10", "2025-11", "2026-09", "2026-10"):
            row = entry(kind="지출", category="식비", amount=-10)
            rows.append((f"{month}-15", *row[1:]))
        report = self.report(rows)
        coverage = ("2025-10-21", "2026-10-21")
        months = monthly_breakdown(report["transactions"], coverage)
        self.assertEqual([item["month"] for item in months], ["2025-11", "2026-09"])
        self.assertEqual([item["total_expense"] for item in months], ["10", "10"])
        self.assertEqual(len(report["transactions"]), 4)
        self.assertEqual(report["coverage"]["classification_signed_totals"]["expense"], "-40")
        self.assertEqual([item["month"] for item in report["monthly_breakdown"]],
                         ["2025-11", "2026-09"])

    def test_future_export_finalizes_only_fully_covered_months(self):
        self.source = (self.root / "Spending" / "Banksalad"
                       / "2026-10-21_2027-02-21" / "source.xlsx")
        self.source.parent.mkdir(parents=True)
        rows = []
        for day in ("2026-10-25", "2026-11-15", "2027-01-15", "2027-02-15"):
            row = entry(kind="지출", category="식비", amount=-10)
            rows.append((day, *row[1:]))
        report = self.report(rows)
        self.assertEqual([item["month"] for item in report["monthly_breakdown"]],
                         ["2026-11", "2027-01"])
        self.assertEqual(len(report["transactions"]), 4)
        self.assertTrue(all(not item["boundary_month_partial"]
                            for item in report["monthly_breakdown"]))

    def test_report_rejects_unknown_or_invalid_export_coverage(self):
        folders = ("unknown", "2026-02-30_2026-03-31", "2026-12-01_2026-11-30",
                   "2026-1-01_2026-12-31", "2026-01-01_2026-12-31_extra")
        for folder in folders:
            with self.subTest(folder=folder):
                self.source = (self.root / "Spending" / "Banksalad"
                               / folder / "source.xlsx")
                self.source.parent.mkdir(parents=True, exist_ok=True)
                workbook(self.source, [entry(kind="지출", category="식비", amount=-10)])
                with self.assertRaisesRegex(ValueError, "Source coverage unknown"):
                    build_report(self.source)
        self.source = self.root / "synthetic.xlsx"
        workbook(self.source, [entry(kind="지출", category="식비", amount=-10)])
        with self.assertRaisesRegex(ValueError, "Source coverage unknown"):
            build_report(self.source)

    def test_approved_source_keeps_eleven_month_values_and_all_raw_rows(self):
        months = [f"{year}-{month:02}" for year, start, end in (
            (2025, 10, 12), (2026, 1, 10)) for month in range(start, end + 1)]
        rows = []
        for month in months:
            row = entry(kind="지출", category="식비", description=f"Synthetic meal {month}",
                        amount=-10)
            rows.append((f"{month}-21", *row[1:]))
        _, transactions = self.load(rows)
        with patch.object(banksalad_audit, "load_transactions", return_value=(
                banksalad_audit.APPROVED_SOURCE_SHA256, transactions)):
            report = build_report(self.source)
        self.assertEqual(report["source_file_sha256"], banksalad_audit.APPROVED_SOURCE_SHA256)
        self.assertEqual(report["coverage"]["transaction_rows"], 13)
        self.assertEqual(report["coverage"]["effective_aggregation_rows"], 13)
        self.assertEqual([item["source_row"] for item in report["transactions"]], list(range(2, 15)))
        self.assertEqual([item["date"][:7] for item in report["transactions"]], months)
        self.assertEqual(report["coverage"]["raw_classification_signed_totals"]["expense"], "-130")
        self.assertEqual([item["month"] for item in report["monthly_breakdown"]], [
            "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
            "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
        ])
        self.assertEqual([item["total_expense"] for item in report["monthly_breakdown"]],
                         ["10"] * 11)
        self.assertTrue(all(not item["boundary_month_partial"]
                            for item in report["monthly_breakdown"]))

    def test_duplicate_decisions_fail_closed_on_evidence_and_reused_rows(self):
        first = entry(category="내계좌이체", description="Synthetic account move")
        changed = list(first)
        changed[9] = "Different memo"
        transit = entry(kind="지출", category="교통", description="Synthetic tram", amount=-11,
                        clock="00:00:00")
        source_hash, rows = self.load([first, first, tuple(changed), transit, transit])
        pair = {"keep_source_row": 2, "exclude_source_row": 3,
                "approval_date": APPROVAL, "treatment": "count_first_once"}
        cases = (
            ("hash", {"source_file_sha256": "wrong"}),
            ("raw_field", {"confirmed_exact_duplicate_pairs": [{**pair, "exclude_source_row": 4}]}),
            ("transit", {"confirmed_exact_duplicate_pairs": [{**pair, "keep_source_row": 5,
                                                                "exclude_source_row": 6}]}),
            ("missing_row", {"confirmed_exact_duplicate_pairs": [{**pair, "exclude_source_row": 99}]}),
            ("reused_row", {"confirmed_exact_duplicate_pairs": [pair, pair]}),
            ("reverse_ids", {"confirmed_exact_duplicate_pairs": [{**pair, "keep_source_row": 3,
                                                                    "exclude_source_row": 2}]}),
        )
        for name, change in cases:
            with self.subTest(name=name):
                owner = decisions(source_hash, confirmed_exact_duplicate_pairs=[pair])
                owner.update(change)
                self.assert_rejected_without_mutation(rows, source_hash, owner)

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
