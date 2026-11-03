import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Table2 } from "lucide-react";
import type { PreviewSheet } from "./previewData";

function columnLabel(column: number): string {
  let result = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

export function SpreadsheetPreview({
  sheets,
  truncated = false,
  showFormatNotice = false,
}: {
  sheets: PreviewSheet[];
  truncated?: boolean;
  showFormatNotice?: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const sheet = sheets[selected];
  const pageSize = 100;
  const pageCount = Math.max(
    1,
    Math.ceil((sheet?.rows.length || 0) / pageSize),
  );
  const columns = Math.min(
    50,
    Math.max(0, ...(sheet?.rows.map((r) => r.length) || [])),
  );
  const select = (index: number) => {
    setSelected(index);
    setPage(0);
    scroll.current?.scrollTo(0, 0);
  };
  const changePage = (next: number) => {
    setPage(next);
    scroll.current?.scrollTo(0, 0);
  };
  if (!sheet)
    return (
      <div className="preview-empty">
        <Table2 size={30} />
        <p>这个工作簿没有可预览的工作表。</p>
      </div>
    );
  return (
    <div className="spreadsheet-preview">
      <div className="sheet-tabs" role="tablist" aria-label="工作表">
        {sheets.map((item, index) => (
          <button
            key={`${index}-${item.name}`}
            role="tab"
            id={`sheet-tab-${index}`}
            aria-controls="sheet-panel"
            aria-selected={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight")
                next = (index + 1) % sheets.length;
              else if (event.key === "ArrowLeft")
                next = (index - 1 + sheets.length) % sheets.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = sheets.length - 1;
              else return;
              event.preventDefault();
              select(next);
              document.getElementById(`sheet-tab-${next}`)?.focus();
            }}
          >
            <Table2 size={13} />
            {item.name}
          </button>
        ))}
      </div>
      <div className="sheet-summary">
        <span>
          {sheet.total_rows_known === false ? "至少 " : ""}
          {sheet.total_rows.toLocaleString()} 行 ·{" "}
          {sheet.total_columns.toLocaleString()} 列
        </span>
        <span>只读预览</span>
      </div>
      {showFormatNotice && (
        <div className="preview-notice" role="note">
          数据预览，图表、图片及复杂格式请下载原文件查看；公式显示文件中已保存的计算结果。
        </div>
      )}
      {sheet.number_format_fallback && (
        <div className="preview-notice" role="note">
          部分数字或日期格式暂不支持，已显示原始值；完整格式请下载查看。
        </div>
      )}
      {(truncated || sheet.truncated) && (
        <div className="preview-notice" role="status">
          已截取部分内容进行预览，下载文件可查看完整数据。
        </div>
      )}
      <div
        ref={scroll}
        id="sheet-panel"
        role="tabpanel"
        aria-labelledby={`sheet-tab-${selected}`}
        tabIndex={0}
        className="sheet-scroll"
      >
        {sheet.rows.length ? (
          <table className="sheet-table" aria-label={`${sheet.name} 数据`}>
            <thead>
              <tr>
                <th className="row-number" aria-label="行号" />
                {Array.from({ length: columns }, (_, index) => (
                  <th scope="col" key={index}>
                    {columnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows
                .slice(page * pageSize, (page + 1) * pageSize)
                .map((row, index) => (
                  <tr key={page * pageSize + index}>
                    <th scope="row" className="row-number">
                      {page * pageSize + index + 1}
                    </th>
                    {Array.from({ length: columns }, (_, column) => (
                      <td
                        key={column}
                        className={
                          typeof row[column] === "number" ? "cell-number" : ""
                        }
                      >
                        {sheet.display_rows?.[page * pageSize + index]?.[
                          column
                        ] ?? (row[column] == null ? "" : String(row[column]))}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <div className="preview-empty">
            <Table2 size={30} />
            <p>此工作表为空。</p>
          </div>
        )}
      </div>
      <div className="sheet-pagination">
        <span>
          {sheet.rows.length
            ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, sheet.rows.length)} / ${sheet.rows.length} 行`
            : "0 行"}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="上一页数据"
            disabled={page === 0}
            onClick={() => changePage(page - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button
            className="icon-button"
            aria-label="下一页数据"
            disabled={page + 1 >= pageCount}
            onClick={() => changePage(page + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
