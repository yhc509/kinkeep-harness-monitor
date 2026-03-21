import { hierarchy, pack } from "d3-hierarchy";
import type { HierarchyCircularNode } from "d3-hierarchy";
import { useState } from "react";
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

interface TooltipState {
  item: ProjectTokenUsageItem;
  x: number;
  y: number;
}

interface BubbleNode {
  x: number;
  y: number;
  r: number;
  item: ProjectTokenUsageItem;
}

type BubbleDatum = { children: ProjectTokenUsageItem[] } | ProjectTokenUsageItem;

export function ProjectBubbleChart({ data }: ProjectBubbleChartProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  if (data.length === 0) {
    return (
      <div className="project-bubble-empty">
        <strong>No project token usage</strong>
        <p>There is no recorded project token usage for the selected period.</p>
      </div>
    );
  }

  const nodes = buildBubbleNodes(data);

  function handlePointerMove(event: ReactMouseEvent<SVGGElement>, item: ProjectTokenUsageItem) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) {
      return;
    }

    const bounds = svg.getBoundingClientRect();
    setTooltip({
      item,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top
    });
  }

  return (
    <div className="project-bubble-shell" onMouseLeave={() => setTooltip(null)}>
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
            <g
              key={`${node.item.projectId}:${index}`}
              className="project-bubble-node"
              transform={`translate(${node.x}, ${node.y})`}
              onMouseMove={(event) => handlePointerMove(event, node.item)}
              onFocus={() => setTooltip({
                item: node.item,
                x: node.x,
                y: node.y
              })}
              onBlur={() => setTooltip(null)}
              tabIndex={0}
            >
              <circle
                className="project-bubble-circle"
                r={node.r}
                fill={pickBubbleColor(index, node.item.projectId)}
                data-kind={isOther ? "other" : isUnknown ? "unknown" : "project"}
              />
              {showName ? (
                <text className="project-bubble-name" textAnchor="middle" dy={showValue ? "-0.2em" : "0.2em"}>
                  {truncateLabel(node.item.projectName, node.r >= 72 ? 18 : 12)}
                </text>
              ) : null}
              {showValue ? (
                <text className="project-bubble-value" textAnchor="middle" dy={showName ? "1.25em" : "0.35em"}>
                  {formatShortNumber(node.item.totalTokens)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {tooltip ? (
        <div
          className="project-bubble-tooltip"
          style={{
            left: `${Math.min(tooltip.x + 14, SVG_WIDTH - 12)}px`,
            top: `${Math.max(tooltip.y - 12, 12)}px`
          }}
        >
          <strong>{tooltip.item.projectName}</strong>
          {tooltip.item.projectPath ? <p>{tooltip.item.projectPath}</p> : null}
          <span>Total tokens {formatNumber(tooltip.item.totalTokens)}</span>
          <span>Requests {formatNumber(tooltip.item.requestCount)}</span>
        </div>
      ) : null}
    </div>
  );
}

function buildBubbleNodes(data: ProjectTokenUsageItem[]): BubbleNode[] {
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
    item: leaf.data as ProjectTokenUsageItem
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
