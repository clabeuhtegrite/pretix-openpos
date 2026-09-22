import { locale, t } from "../i18n";
import type { Attendance, DoorScans } from "../types";

/**
 * How many people are in the room, and how they got there.
 *
 * The number an operator actually wants at a door is a single one; the rest of
 * this panel exists to make that number trustworthy, by showing what it was
 * derived from — tickets expected, people let in, people scanned back out —
 * rather than asking anyone to take it on faith.
 */

interface Props {
  data: Attendance | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

/** One box of the flow diagram, in viewBox units. */
interface Box {
  x: number;
  y: number;
  width: number;
  label: string;
  value: number;
  tone?: "inside" | "waiting" | "exited";
}

const NODE_HEIGHT = 54;
const VIEW_WIDTH = 360;

function FlowNode({ x, y, width, label, value, tone }: Box) {
  const centre = x + width / 2;
  return (
    <g>
      <rect
        className={`flow-box${tone ? ` is-${tone}` : ""}`}
        x={x}
        y={y}
        width={width}
        height={NODE_HEIGHT}
        rx={10}
      />
      <text className="flow-label" x={centre} y={y + 20} textAnchor="middle">
        {label}
      </text>
      <text
        className={`flow-value${tone === "inside" ? " is-inside" : ""}`}
        x={centre}
        y={y + 44}
        textAnchor="middle"
      >
        {value}
      </text>
    </g>
  );
}

/**
 * Connector from the bottom of one box down to the top of two others.
 *
 * Drawn as plain paths with their own arrowheads rather than through an SVG
 * marker: a marker needs a document-unique id, and this costs less than
 * inventing one.
 */
function Fork({ from, to, top, bottom }: { from: number; to: number[]; top: number; bottom: number }) {
  const middle = (top + bottom) / 2;
  return (
    <g className="flow-link">
      <path d={`M ${from} ${top} V ${middle}`} />
      <path d={`M ${Math.min(...to)} ${middle} H ${Math.max(...to)}`} />
      {to.map((x) => (
        <g key={x}>
          <path d={`M ${x} ${middle} V ${bottom - 6}`} />
          <path className="flow-arrow" d={`M ${x - 5} ${bottom - 7} L ${x + 5} ${bottom - 7} L ${x} ${bottom} Z`} />
        </g>
      ))}
    </g>
  );
}

/**
 * The room as a diagram.
 *
 * Two shapes, picked by the data: most events never scan anyone out, and a
 * three-level chart whose bottom row reads "0 left" would be structure for the
 * sake of structure. As soon as one exit scan exists, the split appears.
 */
function FlowChart({ data, withExits }: { data: Attendance; withExits: boolean }) {
  const height = withExits ? 250 : 166;

  const expected: Box = {
    x: 100,
    y: 6,
    width: 160,
    label: t("attendance.expected"),
    value: data.expected,
  };
  const notArrived: Box = {
    x: 190,
    y: 96,
    width: 160,
    label: t("attendance.notArrived"),
    value: data.not_arrived,
    tone: "waiting",
  };
  // Without exits, everyone who came in is still in: the second level says so
  // directly instead of adding a level that would only ever restate it.
  const admitted: Box = withExits
    ? { x: 10, y: 96, width: 160, label: t("attendance.entered"), value: data.entered }
    : { x: 10, y: 96, width: 160, label: t("attendance.onSite"), value: data.inside, tone: "inside" };

  return (
    <svg
      className="flow"
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      role="img"
      aria-label={t("attendance.diagram", {
        expected: data.expected,
        entered: data.entered,
        inside: data.inside,
        exited: data.exited,
      })}
    >
      <FlowNode {...expected} />
      <Fork
        from={expected.x + expected.width / 2}
        to={[admitted.x + admitted.width / 2, notArrived.x + notArrived.width / 2]}
        top={expected.y + NODE_HEIGHT}
        bottom={admitted.y}
      />
      <FlowNode {...admitted} />
      <FlowNode {...notArrived} />

      {withExits && (
        <>
          <Fork
            from={admitted.x + admitted.width / 2}
            to={[49, 131]}
            top={admitted.y + NODE_HEIGHT}
            bottom={186}
          />
          <FlowNode
            x={10}
            y={186}
            width={78}
            label={t("attendance.onSite")}
            value={data.inside}
            tone="inside"
          />
          <FlowNode
            x={92}
            y={186}
            width={78}
            label={t("attendance.exited")}
            value={data.exited}
            tone="exited"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Every door's scans tonight, one line per device.
 *
 * The figure that answers "did we lose scans?": a phone whose line is short of
 * what its volunteer remembers let people in that pretix never heard of, and
 * the offline column says how many of the others spent a while in a phone
 * before they arrived.
 */
function DeviceTable({ scans }: { scans: DoorScans }) {
  return (
    <>
      <h3 className="attendance-subtitle">{t("attendance.byDevice")}</h3>
      <table className="takings">
        <thead>
          <tr>
            <th>{t("attendance.device")}</th>
            <th>{t("attendance.entered")}</th>
            <th>{t("attendance.refused")}</th>
            <th>{t("attendance.offline")}</th>
          </tr>
        </thead>
        <tbody>
          {scans.devices.map((device, i) => (
            // By position: two phones may well carry the same name.
            <tr key={i}>
              <td>
                {device.name ?? t("attendance.backOffice")}
                {device.current && (
                  <>
                    {" "}
                    <span className="attendance-this">· {t("attendance.thisDevice")}</span>
                  </>
                )}
              </td>
              <td>
                <strong>{device.admitted}</strong>
              </td>
              <td>{device.refused}</td>
              <td>{device.offline}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="attendance-note">{t("attendance.byDeviceExplain")}</div>
    </>
  );
}

export default function AttendancePanel({ data, busy, error, onRefresh, onClose }: Props) {
  const percent = data && data.expected ? Math.round((data.entered * 100) / data.expected) : 0;
  // One rule for the whole panel: the "who came in at all" dimension only earns
  // its place once someone has been scanned back out. Without exit scans it is
  // the same number as "on site", in the chart as in the table.
  const withExits = !!data && data.exited > 0;

  return (
    <div className="overlay overlay-top" onClick={onClose}>
      <div className="panel attendance-panel" onClick={(e) => e.stopPropagation()}>
        <h2>{t("attendance.title")}</h2>

        {error && <div className="error-banner">{error}</div>}

        {!data ? (
          <p style={{ color: "var(--text-dim)" }}>{busy ? t("attendance.loading") : "—"}</p>
        ) : (
          <>
            <div className="attendance-headline">
              <div className="attendance-count">{data.inside}</div>
              <div className="attendance-caption">{t("attendance.inside")}</div>
            </div>

            {data.expected > 0 ? (
              <>
                <FlowChart data={data} withExits={withExits} />
                <div className="fill-bar" aria-hidden="true">
                  <span className="fill-bar-value" style={{ width: `${percent}%` }} />
                </div>
                <div className="attendance-note">
                  {t("attendance.fill", {
                    entered: data.entered,
                    expected: data.expected,
                    percent,
                  })}
                </div>
              </>
            ) : (
              <div className="attendance-note">{t("attendance.empty")}</div>
            )}

            {data.items.length > 1 && (
              <>
                <h3 className="attendance-subtitle">{t("attendance.byProduct")}</h3>
                <table className="takings">
                  <thead>
                    <tr>
                      <th>{t("attendance.product")}</th>
                      <th>{t("attendance.onSite")}</th>
                      {withExits && <th>{t("attendance.entered")}</th>}
                      <th>{t("attendance.expectedShort")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.name}</td>
                        <td>
                          <strong>{item.inside}</strong>
                        </td>
                        {withExits && <td>{item.entered}</td>}
                        <td>{item.expected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {data.scans && data.scans.devices.length > 0 && <DeviceTable scans={data.scans} />}

            <div className="attendance-note">
              {t("attendance.explain")}
              {data.non_admission_entered > 0 && (
                <> {t("attendance.nonAdmission", { n: data.non_admission_entered })}</>
              )}
            </div>
            <div className="attendance-note">
              {data.list.name} ·{" "}
              {t("attendance.updated", {
                time: new Date(data.computed_at).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </div>
          </>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
          <button className="btn ghost" onClick={onRefresh} disabled={busy}>
            {busy ? t("attendance.loading") : t("attendance.refresh")}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t("settings.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
