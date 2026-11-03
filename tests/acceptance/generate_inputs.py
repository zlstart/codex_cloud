"""Create deterministic synthetic manufacturing acceptance inputs and private oracle.

Only upload the two files listed under ``inputs`` in expected-results.json.
The expected results and prompt manifest stay outside the model workspace.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

CSV_NAME = "2026年10月生产明细.csv"
XLSX_NAME = "2026年10月经营补充.xlsx"
FIELDS = [
    "记录编号", "日期", "产线", "班次", "产品", "计划产量_吨", "实际产量_吨",
    "合格产量_吨", "不良产量_吨", "停机分钟", "电耗_kWh",
]
LINES = [
    ("制粒A线", "禽料颗粒", 78, 39, 2850, "0.980", "0.970", 42),
    ("制粒B线", "畜料颗粒", 92, 41, 2920, "0.975", "0.970", 44),
    ("膨化C线", "水产膨化料", 66, 54, 3450, "0.975", "0.950", 57),
    ("混合D线", "预混料", 105, 25, 2480, "0.985", "0.980", 28),
]


def rounded(value: Decimal | int, places: int = 2) -> str:
    return str(Decimal(value).quantize(Decimal(10) ** -places, rounding=ROUND_HALF_UP))


def create_sources(output: Path) -> tuple[Path, Path]:
    """Write inputs only; the oracle below separately reads serialized files."""
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for day_index in range(12):
        current = date(2026, 10, 19) + timedelta(days=day_index)
        for line_index, (line, product, base, energy, *_rest) in enumerate(LINES):
            for shift_index, shift in enumerate(("白班", "夜班")):
                record_index = len(rows) + 1
                planned = base + (day_index % 3) * 3 + shift_index * 4
                actual = planned + ((day_index * 7 + line_index * 5 + shift_index * 3) % 15) - 7
                defective = max(1, actual * (16, 29, 21, 12)[line_index] // 1000)
                defective += (day_index + shift_index) % 2
                downtime = 12 + (day_index * 11 + line_index * 7 + shift_index * 13) % 45
                electricity = actual * energy + downtime * 4 + (day_index % 3) * 11
                if record_index == 62:
                    actual, defective, downtime, electricity = 0, 0, 480, 640
                rows.append({
                    "记录编号": f"SC{record_index:04d}", "日期": current.isoformat(), "产线": line,
                    "班次": shift, "产品": product, "计划产量_吨": planned, "实际产量_吨": actual,
                    "合格产量_吨": actual - defective, "不良产量_吨": defective,
                    "停机分钟": "" if record_index in {7, 51} else downtime,
                    "电耗_kWh": "" if record_index in {11, 39, 74} else electricity,
                })
    with (output / CSV_NAME).open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows + [dict(rows[index - 1]) for index in (5, 28, 87)])

    workbook = Workbook()
    notes = workbook.active
    notes.title = "口径说明"
    notes.append(["项目", "处理规则"])
    for values in [
        ("数据性质", "全部为合成验收数据，不涉及真实客户或经营资料。"),
        ("去重", "生产记录编号应唯一；完全重复的记录保留首条。"),
        ("缺失值", "电耗或停机空白表示未记录，保留缺失，不填零。"),
        ("零产量", "零产量记录保留在产量、计划和停机统计中，不计算该行单位电耗。"),
        ("加权指标", "良品率=合格总产量/实际总产量；计划达成率=实际总产量/计划总产量。"),
        ("单位电耗", "只用电耗有效且实际产量大于零的记录：电耗合计/同范围实际产量合计。"),
        ("发货收入", "逐条发货量乘单价后求和，单位为元；不等同于利润或回款。"),
        ("排名", "产线按实际总产量降序排名；汇总和排名须先完成生产记录去重。"),
    ]:
        notes.append(values)
    targets = workbook.create_sheet("产线目标")
    targets.append(["产线", "良品率目标", "产量达成率目标", "单位电耗目标_kWh每吨"])
    for line, _product, _base, _energy, _price, quality, attainment, energy_target in LINES:
        targets.append([line, float(quality), float(attainment), energy_target])
        targets.cell(targets.max_row, 2).number_format = "0.00%"
        targets.cell(targets.max_row, 3).number_format = "0.00%"
    shipments = workbook.create_sheet("发货记录")
    shipments.append(["发货单号", "日期", "产线", "产品", "发货量_吨", "单价_元每吨"])
    for day_index in range(12):
        current = (date(2026, 10, 19) + timedelta(days=day_index)).isoformat()
        for line_index, (line, product, _base, _energy, price, *_rest) in enumerate(LINES):
            daily_actual = sum(row["实际产量_吨"] for row in rows if row["日期"] == current and row["产线"] == line)
            quantity = max(0, daily_actual - (12, 16, 9, 20)[line_index] + day_index % 4)
            shipments.append([
                f"FH{current.replace('-', '')}{line_index + 1}", current, line, product,
                quantity, price + (day_index // 4) * 15,
            ])
    for sheet in workbook:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="174E68")
        for column in sheet.columns:
            letter = column[0].column_letter
            sheet.column_dimensions[letter].width = 24 if sheet.title != "口径说明" else (18 if letter == "A" else 105)
    workbook.save(output / XLSX_NAME)
    return output / CSV_NAME, output / XLSX_NAME


def calculate_expected(csv_path: Path, xlsx_path: Path) -> dict:
    """Independent oracle: CSV/stdlib Decimal + read-only workbook, no model output."""
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        source_rows = list(csv.DictReader(handle))
    seen = {}
    duplicate_ids = []
    for row in source_rows:
        record_id = row["记录编号"]
        if record_id in seen:
            if row != seen[record_id]:
                raise ValueError(f"Conflicting duplicate ID: {record_id}")
            duplicate_ids.append(record_id)
        else:
            seen[record_id] = row
    rows = list(seen.values())
    metrics = {
        "planned_tonnes": "计划产量_吨", "actual_tonnes": "实际产量_吨",
        "good_tonnes": "合格产量_吨", "defective_tonnes": "不良产量_吨",
    }
    totals = {key: sum(int(row[column]) for row in rows) for key, column in metrics.items()}
    assert totals["actual_tonnes"] == totals["good_tonnes"] + totals["defective_tonnes"]
    totals["weighted_quality_pct"] = rounded(Decimal(totals["good_tonnes"]) / totals["actual_tonnes"] * 100)
    totals["attainment_pct"] = rounded(Decimal(totals["actual_tonnes"]) / totals["planned_tonnes"] * 100)
    energy_rows = [row for row in rows if row["电耗_kWh"] and int(row["实际产量_吨"]) > 0]
    totals["energy_eligible_rows"] = len(energy_rows)
    totals["energy_eligible_actual_tonnes"] = sum(int(row["实际产量_吨"]) for row in energy_rows)
    totals["energy_eligible_kwh"] = sum(int(row["电耗_kWh"]) for row in energy_rows)
    totals["specific_energy_kwh_per_tonne"] = rounded(
        Decimal(totals["energy_eligible_kwh"]) / totals["energy_eligible_actual_tonnes"]
    )
    totals["known_downtime_minutes"] = sum(int(row["停机分钟"]) for row in rows if row["停机分钟"])
    totals["known_energy_kwh"] = sum(int(row["电耗_kWh"]) for row in rows if row["电耗_kWh"])
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["产线"]].append(row)
    ranking = []
    for line, records in grouped.items():
        values = {key: sum(int(row[column]) for row in records) for key, column in metrics.items()}
        values["weighted_quality_pct"] = rounded(Decimal(values["good_tonnes"]) / values["actual_tonnes"] * 100)
        values["attainment_pct"] = rounded(Decimal(values["actual_tonnes"]) / values["planned_tonnes"] * 100)
        eligible = [row for row in records if row["电耗_kWh"] and int(row["实际产量_吨"]) > 0]
        values["specific_energy_kwh_per_tonne"] = rounded(
            Decimal(sum(int(row["电耗_kWh"]) for row in eligible)) / sum(int(row["实际产量_吨"]) for row in eligible)
        )
        ranking.append({"line": line, "records": len(records), **values})
    ranking.sort(key=lambda item: (-item["actual_tonnes"], item["line"]))
    workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
    shipments = list(workbook["发货记录"].iter_rows(min_row=2, values_only=True))
    shipping = {
        "records": len(shipments), "quantity_tonnes": sum(row[4] for row in shipments),
        "revenue_yuan": sum(row[4] * row[5] for row in shipments),
    }
    target_rows = list(workbook["产线目标"].iter_rows(min_row=2, values_only=True))
    targets = {row[0]: {
        "quality_pct": rounded(Decimal(str(row[1])) * 100),
        "attainment_pct": rounded(Decimal(str(row[2])) * 100), "energy_kwh_per_tonne": row[3],
    } for row in target_rows}
    workbook.close()
    checks = []
    for key, label, aliases, value in [
        ("unique_rows", "有效生产记录", ["有效生产记录", "去重后记录", "有效记录数"], len(rows)),
        ("duplicate_rows", "重复记录", ["重复记录", "重复行数", "删除重复"], len(duplicate_ids)),
        ("planned_tonnes", "计划总产量", ["计划总产量", "计划产量合计"], totals["planned_tonnes"]),
        ("actual_tonnes", "实际总产量", ["实际总产量", "实际产量合计"], totals["actual_tonnes"]),
        ("good_tonnes", "合格总产量", ["合格总产量", "良品总产量", "合格产量合计"], totals["good_tonnes"]),
        ("defective_tonnes", "不良总产量", ["不良总产量", "不良产量合计"], totals["defective_tonnes"]),
        ("weighted_quality_pct", "加权良品率", ["加权良品率", "整体良品率", "综合良品率"], totals["weighted_quality_pct"]),
        ("attainment_pct", "计划达成率", ["计划达成率", "产量达成率"], totals["attainment_pct"]),
        ("shipped_tonnes", "发货总量", ["发货总量", "发货量合计"], shipping["quantity_tonnes"]),
        ("revenue_yuan", "发货收入", ["发货收入", "发货总收入", "发货销售额"], shipping["revenue_yuan"]),
        ("top_line", "产量第一产线", ["产量第一产线", "产量排名第一", "产量冠军"], ranking[0]["line"]),
    ]:
        if key == "top_line":
            formats = [str(value)]
        else:
            number = Decimal(str(value))
            formats = list(dict.fromkeys([str(value), f"{number:,.2f}", f"{number:.2f}", f"{number:,f}"]))
        checks.append({"key": key, "label": label, "aliases": aliases, "value": value, "formats": formats})
    return {
        "schema_version": 1, "synthetic": True,
        "inputs": {"production_csv": csv_path.name, "supplement_xlsx": xlsx_path.name},
        "period": {"start": min(row["日期"] for row in rows), "end": max(row["日期"] for row in rows)},
        "production": {
            "source_rows": len(source_rows), "unique_rows": len(rows), "duplicate_rows": len(duplicate_ids),
            "duplicate_ids": duplicate_ids,
            "missing_after_dedup": {column: sum(not row[column] for row in rows) for column in ("停机分钟", "电耗_kWh")},
            "zero_output_ids": [row["记录编号"] for row in rows if int(row["实际产量_吨"]) == 0],
            "date_counts": dict(sorted(Counter(row["日期"] for row in rows).items())),
            "totals": totals, "line_ranking": ranking,
        },
        "shipments": shipping, "targets": targets, "report_checks": checks,
    }


def prompt_manifest() -> dict:
    source = f"请分析我上传的《{CSV_NAME}》和《{XLSX_NAME}》，仅使用这些合成数据。"
    return {
        "analysis_prompt": source + (
            "先读取工作簿所有工作表及口径说明。按记录编号去重，明确原始行数、有效行数、重复行数、"
            "缺失值和零产量异常；不得把缺失电耗或停机补成零。核对实际=合格+不良，计算总量、"
            "加权良品率、计划达成率、有效口径单位电耗、发货总量和收入；按实际产量排名四条产线，"
            "对照目标解释差距，并给出有数据依据的改进建议。先回复分析结论及处理口径，暂不生成最终文件。"
        ),
        "deliverables_prompt": (
            "请基于刚才的分析和原始上传文件，制作可直接下载的中文管理报告：独立可打开的HTML、"
            "Excel分析工作簿、Word报告、PDF报告和PowerPoint汇报，各一个文件，存入outputs目录。"
            "五种成果必须保持同一数据口径，且每份均包含一张完整的两列核心指标表，指标名固定为："
            "有效生产记录、重复记录、计划总产量、实际总产量、合格总产量、不良总产量、加权良品率、"
            "计划达成率、发货总量、发货收入、产量第一产线；数量写完整数值、收入单位为元、产量单位为吨、"
            "百分比保留两位小数，不用“万”缩写替代指标表数值。另包含数据质量说明、四条产线排名、"
            "目标差距、至少两张分析图和行动建议。Excel至少含汇总、清洗明细、产线分析三个工作表，"
            "公式需有可读取的计算结果；PowerPoint至少五页，可把核心指标表分为相邻两页。PDF所有页"
            "都应有可提取的中文文字，不要仅用图片代替正文，检查中文字体无方框。HTML应可离线打开，"
            "不依赖外部脚本或图片。生成后自行重新打开五种文件检查格式和关键数值，最后分别给出下载链接。"
        ),
        "private_validation_note": "Do not upload expected-results.json or prompts.json. Never include oracle values in prompts.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("test-results/production-acceptance-2026-11-03/inputs"))
    args = parser.parse_args()
    csv_path, xlsx_path = create_sources(args.output)
    expected = calculate_expected(csv_path, xlsx_path)
    (args.output / "expected-results.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n")
    (args.output / "prompts.json").write_text(json.dumps(prompt_manifest(), ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"input_files": expected["inputs"], "production": expected["production"], "shipments": expected["shipments"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
