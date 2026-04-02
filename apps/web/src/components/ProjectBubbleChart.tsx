import { hierarchy, pack } from "d3-hierarchy";
import type { HierarchyCircularNode } from "d3-hierarchy";
import { useState } from "react";
import type { FocusEvent as ReactFocusEvent } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ProjectTokenUsageItem } from "@codex-monitor/shared";
import { formatNumber, formatShortNumber } from "../utils/format";

const SVG_WIDTH = 720;
const SVG_HEIGHT = 360;

const bubbleColors = [
  "var(--accent)",
  "#c4b5fd",
  "#8b7ed8",
  "var(--provider-claude)",
  "#ffd08c",
  "var(--provider-codex)",
  "#7ce3ff",
  "var(--provider-agents)",
  "#8dd96f",
  "#f97b72",
  "#9f8cff",
  "#46c9b8",
  "#f28c28"
];

interface ProjectBubbleChartProps {
  data: ProjectTokenUsageItem[];
}

interface ChartItem extends ProjectTokenUsageItem {
  color: string;
  share: number;
}

interface TooltipState {
  item: ChartItem;
  x: number;
  y: number;
  chartWidth: number;
}

interface BubbleNode {
  x: number;
  y: number;
  r: number;
  item: ChartItem;
}

type BubbleDatum = { children: ChartItem[] } | ChartItem;

export function ProjectBubbleChart({ data }: ProjectBubbleChartProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (data.length === 0) {
    return (
      <div className="project-bubble-empty">
        <strong>No project token usage</strong>
        <p>There is no recorded project token usage for the selected period.</p>
      </div>
    );
  }

  const totalTokens = data.reduce((sum, item) => sum + item.totalTokens, 0);
  const chartData = [...data]
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        right.requestCount - left.requestCount ||
        left.projectName.localeCompare(right.projectName)
    )
    .map((item, index) => ({
      ...item,
      color: pickBubbleColor(index, item.projectId),
      share: totalTokens > 0 ? item.totalTokens / totalTokens : 0
    }));
  const nodes = buildBubbleNodes(chartData);

  function handlePointerMove(event: ReactMouseEvent<SVGGElement>, item: ChartItem) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) {
      return;
    }

    const bounds = svg.getBoundingClientRect();
    setHoveredId(item.projectId);
    setTooltip({
      item,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      chartWidth: bounds.width
    });
  }

  function handleNodeFocus(event: ReactFocusEvent<SVGGElement>, item: ChartItem) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) {
      return;
    }

    const svgBounds = svg.getBoundingClientRect();
    const nodeBounds = event.currentTarget.getBoundingClientRect();

    setHoveredId(item.projectId);
    setTooltip({
      item,
      x: nodeBounds.left - svgBounds.left + nodeBounds.width / 2,
      y: nodeBounds.top - svgBounds.top + nodeBounds.height / 2,
      chartWidth: svgBounds.width
    });
  }

  return (
    <div
      className="project-bubble-shell"
      data-hovered={hoveredId ?? undefined}
      onMouseLeave={() => {
        setHoveredId(null);
        setTooltip(null);
      }}
    >
      <div className="project-bubble-chart-area">
        <svg
          className="project-bubble-svg"
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          role="img"
          aria-label="Project token usage bubble chart"
        >
          {nodes.map((node, index) => {
            const showName = node.r >= 40;
            const showValue = node.r >= 58;
            const isOther = node.item.projectId === "__other__";
            const isUnknown = node.item.projectId === "__unknown__";

            return (
              <g key={`${node.item.projectId}:${index}`} transform={`translate(${node.x}, ${node.y})`}>
                <g
                  className="project-bubble-node"
                  data-active={(hoveredId === node.item.projectId).toString()}
                  onMouseEnter={(event) => handlePointerMove(event, node.item)}
                  onMouseMove={(event) => handlePointerMove(event, node.item)}
                  onMouseLeave={() => {
                    setHoveredId(null);
                    setTooltip(null);
                  }}
                  onFocus={(event) => handleNodeFocus(event, node.item)}
                  onBlur={() => {
                    setHoveredId(null);
                    setTooltip(null);
                  }}
                  tabIndex={0}
                >
                  <circle
                    className="project-bubble-circle"
                    r={node.r}
                    fill={node.item.color}
                    data-kind={isOther ? "other" : isUnknown ? "unknown" : "project"}
                  />
                  {showName ? (
                    <text className="project-bubble-name" textAnchor="middle" dy={showValue ? "-0.2em" : "0.2em"}>
                      {truncateLabel(node.item.projectName, node.r >= 72 ? 18 : 12)}
                    </text>
                  ) : null}
                  {showValue ? (
                    <text className="project-bubble-value" textAnchor="middle" dy={showName ? "1.25em" : "0.35em"}>
                      {`${formatShortNumber(node.item.totalTokens)} · ${formatPercent(node.item.share, 0)}`}
                    </text>
                  ) : null}
                </g>
              </g>
            );
          })}
        </svg>

        {tooltip ? (
          <div
            className="project-bubble-tooltip"
            style={{
              left: `${Math.min(tooltip.x + 14, tooltip.chartWidth - 12)}px`,
              top: `${Math.max(tooltip.y - 12, 12)}px`
            }}
          >
            <strong>{tooltip.item.projectName}</strong>
            {tooltip.item.projectPath ? <p>{tooltip.item.projectPath}</p> : null}
            <span>Total tokens {formatNumber(tooltip.item.totalTokens)}</span>
            <span>Share {formatPercent(tooltip.item.share, 1)}</span>
            <span>Token events {formatNumber(tooltip.item.requestCount)}</span>
          </div>
        ) : null}
      </div>

      <div className="project-bubble-legend">
        {chartData.map((item) => (
          <div
            key={item.projectId}
            className="project-bubble-legend-row"
            data-active={(hoveredId === item.projectId).toString()}
            onMouseEnter={() => {
              setHoveredId(item.projectId);
              setTooltip(null);
            }}
            onMouseLeave={() => setHoveredId(null)}
          >
            <div className="project-bubble-legend-main">
              <span className="project-bubble-swatch" style={{ backgroundColor: item.color }} />
              <div className="project-bubble-legend-copy">
                <strong>{item.projectName}</strong>
              </div>
            </div>
            <div className="project-bubble-legend-value">
              <strong>{formatNumber(item.totalTokens)}</strong>
              <span>{formatPercent(item.share, 1)}</span>
              <span>{formatNumber(item.requestCount)} token events</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildBubbleNodes(data: ChartItem[]): BubbleNode[] {
  const root = hierarchy<BubbleDatum>({ children: data })
    .sum((item) => ("totalTokens" in item ? Math.max(item.totalTokens, 1) : 0))
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0));

  const packed = pack<BubbleDatum>()
    .size([SVG_WIDTH, SVG_HEIGHT])
    .padding(8)(root);

  return packed.leaves().map((leaf: HierarchyCircularNode<BubbleDatum>) => ({
    x: leaf.x ?? 0,
    y: leaf.y ?? 0,
    r: leaf.r ?? 0,
    item: leaf.data as ChartItem
  }));
}

function pickBubbleColor(index: number, projectId: string): string {
  if (projectId === "__other__") {
    return "rgba(255, 255, 255, 0.18)";
  }

  if (projectId === "__unknown__") {
    return "rgba(255, 180, 84, 0.52)";
  }

  return bubbleColors[index % bubbleColors.length];
}

function truncateLabel(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(1, limit - 1))}…`;
}

function formatPercent(value: number, fractionDigits: number): string {
  return `${(value * 100).toFixed(fractionDigits)}%`;
}
