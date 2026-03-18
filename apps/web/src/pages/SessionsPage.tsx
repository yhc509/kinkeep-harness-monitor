import type { ProjectSummary, SessionDetail, SessionListItem, SubagentSummary } from "@codex-monitor/shared";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, ChevronDown, FolderOpen, Folders, MessagesSquare, Search, SlidersHorizontal } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiResourceKeys, getProjects, getSessionDetail, getSessions } from "../api";
import { AsyncPane } from "../components/AsyncPane";
import { Panel } from "../components/Panel";
import { SessionTimeline } from "../components/SessionTimeline";
import { useApiResource } from "../hooks/useApiResource";
import { formatDateTime } from "../utils/format";

const emptyProjects: ProjectSummary[] = [];
const emptySessions: SessionListItem[] = [];

export function SessionsPage() {
  const navigate = useNavigate();
  const params = useParams<{ projectId?: string; sessionId?: string }>();
  const [search, setSearch] = useState("");
  const [showActivity, setShowActivity] = useState(true);
  const [showTechnical, setShowTechnical] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [showSubagentSummary, setShowSubagentSummary] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const isProjectBrowser = !params.projectId;
  const isSessionBrowser = Boolean(params.projectId && !params.sessionId);

  useEffect(() => {
    setSearch("");
    setIncludeSubagents(false);
  }, [params.projectId]);

  useEffect(() => {
    setShowTechnical(false);
    setShowSubagentSummary(false);
  }, [params.sessionId]);

  const projects = useApiResource(
    () => (isProjectBrowser || params.projectId) ? getProjects(isProjectBrowser ? deferredSearch : "") : Promise.resolve(emptyProjects),
    {
      deps: [isProjectBrowser, params.projectId, deferredSearch],
      cacheKey: apiResourceKeys.projects(isProjectBrowser ? deferredSearch : ""),
      enabled: isProjectBrowser || Boolean(params.projectId),
      staleTimeMs: 15_000
    }
  );
  const sessions = useApiResource(
    () => isSessionBrowser && params.projectId
      ? getSessions({ projectId: params.projectId, query: deferredSearch, includeSubagents })
      : Promise.resolve(emptySessions),
    {
      deps: [includeSubagents, isSessionBrowser, params.projectId, deferredSearch],
      cacheKey: apiResourceKeys.sessions({ projectId: params.projectId, query: deferredSearch, includeSubagents }),
      enabled: isSessionBrowser && Boolean(params.projectId),
      staleTimeMs: 10_000
    }
  );
  const detail = useApiResource(
    () => params.sessionId ? getSessionDetail(params.sessionId) : Promise.resolve(null),
    {
      deps: [params.sessionId],
      cacheKey: apiResourceKeys.sessionDetail(params.sessionId ?? ""),
      enabled: Boolean(params.sessionId),
      keepPreviousData: false,
      staleTimeMs: 10_000
    }
  );

  const activeProject = useMemo(() => {
    if (!params.projectId) {
      return null;
    }

    return projects.data?.find((project) => project.id === params.projectId)
      ?? (detail.data
        ? {
            id: detail.data.projectId,
            name: detail.data.projectName,
            path: detail.data.projectPath,
            sessionCount: detail.data.isSubagent ? 0 : 1,
            subagentCount: detail.data.isSubagent ? 1 : detail.data.subagents.length,
            updatedAt: detail.data.updatedAt,
            lastSessionTitle: detail.data.title
          }
        : null)
      ?? (sessions.data?.[0]
        ? {
            id: sessions.data[0].projectId,
            name: sessions.data[0].projectName,
            path: sessions.data[0].projectPath,
            sessionCount: sessions.data.filter((session) => !session.isSubagent).length,
            subagentCount: sessions.data.filter((session) => session.isSubagent).length,
            updatedAt: sessions.data[0].updatedAt,
            lastSessionTitle: sessions.data[0].title
          }
        : null);
  }, [detail.data, params.projectId, projects.data, sessions.data]);

  const groupedSessions = useMemo(() => {
    const items = sessions.data ?? [];
    const roots = items.filter((session) => !session.isSubagent);
    const rootIds = new Set(roots.map((session) => session.id));
    const childrenByParent = new Map<string, SessionListItem[]>();
    const orphans: SessionListItem[] = [];

    for (const session of items) {
      if (!session.isSubagent) {
        continue;
      }

      if (session.parentThreadId && rootIds.has(session.parentThreadId)) {
        const bucket = childrenByParent.get(session.parentThreadId) ?? [];
        bucket.push(session);
        childrenByParent.set(session.parentThreadId, bucket);
        continue;
      }

      orphans.push(session);
    }

    return {
      groups: roots.map((session) => ({
        session,
        subagents: childrenByParent.get(session.id) ?? []
      })),
      orphans
    };
  }, [sessions.data]);

  useEffect(() => {
    if (detail.data && params.projectId && detail.data.projectId !== params.projectId) {
      navigate(`/sessions/projects/${detail.data.projectId}/${detail.data.id}`, { replace: true });
    }
  }, [detail.data, navigate, params.projectId]);

  if (isProjectBrowser) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <div>
            <p className="eyebrow">SESSIONS</p>
            <h2>프로젝트 선택</h2>
          </div>
          {projects.data ? (
            <div className="page-chip-group">
              <div className="page-chip">
                <Folders size={14} strokeWidth={2.2} />
                <span>{projects.data.length} projects</span>
              </div>
            </div>
          ) : null}
          <label className="search-wrap">
            <Search size={14} strokeWidth={2.2} />
            <input
              className="search-input"
              placeholder="프로젝트 이름 또는 경로 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </section>

        <Panel title="Projects" subtitle="최근 작업 순" icon={<Folders size={16} strokeWidth={2.2} />}>
          <AsyncPane loading={projects.initialLoading} error={projects.error} hasData={projects.hasData}>
            {projects.data?.length ? (
              <div className="project-list dense-list">
                {projects.data.map((project) => (
                  <Link key={project.id} to={`/sessions/projects/${project.id}`} className="project-card">
                    <div className="project-card-main">
                      <span className="project-card-icon" aria-hidden="true">
                        <FolderOpen size={18} strokeWidth={2.2} />
                      </span>
                      <div className="project-card-copy">
                        <strong>{project.name}</strong>
                        <p>{project.path}</p>
                      </div>
                    </div>
                    <div className="project-card-meta">
                      <span>{project.sessionCount} sessions</span>
                      {project.subagentCount > 0 ? <span>+{project.subagentCount} sub</span> : null}
                      <span>{formatDateTime(project.updatedAt)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="state-box">프로젝트 없음</div>
            )}
          </AsyncPane>
        </Panel>
      </div>
    );
  }

  if (isSessionBrowser) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <div className="heading-stack">
            <Link to="/sessions" className="back-link">
              <ArrowLeft size={14} strokeWidth={2.2} />
              프로젝트 목록
            </Link>
            <div>
              <p className="eyebrow">PROJECT</p>
              <h2>{activeProject?.name ?? "프로젝트"}</h2>
              <p className="heading-subtle">{activeProject?.path ?? params.projectId}</p>
            </div>
          </div>
          {activeProject ? (
            <div className="page-chip-group">
              <div className="page-chip">
                <MessagesSquare size={14} strokeWidth={2.2} />
                <span>{activeProject.sessionCount} roots</span>
              </div>
              {activeProject.subagentCount > 0 ? (
                <div className="page-chip">
                  <Bot size={14} strokeWidth={2.2} />
                  <span>{activeProject.subagentCount} sub</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <label className="search-wrap">
            <Search size={14} strokeWidth={2.2} />
            <input
              className="search-input"
              placeholder="이 프로젝트의 세션 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </section>

        <Panel
          title="Sessions"
          subtitle="루트 세션 중심"
          icon={<MessagesSquare size={16} strokeWidth={2.2} />}
          actions={(
            <div className="panel-badges">
              <button className="ghost-button" onClick={() => setIncludeSubagents((prev) => !prev)}>
                <Bot size={14} strokeWidth={2.2} />
                {includeSubagents ? "서브에이전트 숨기기" : "서브에이전트 포함"}
              </button>
            </div>
          )}
        >
          <AsyncPane
            loading={sessions.initialLoading || projects.initialLoading}
            error={sessions.error ?? projects.error}
            hasData={sessions.hasData || projects.hasData}
          >
            {activeProject ? (
              groupedSessions.groups.length || groupedSessions.orphans.length ? (
                <div className="session-browser-list dense-list">
                  {groupedSessions.groups.map(({ session, subagents }) => (
                    <div key={session.id} className="session-group">
                      <Link
                        to={`/sessions/projects/${session.projectId}/${session.id}`}
                        className="session-browser-item"
                      >
                        <div className="session-browser-copy">
                          <strong className="title-clamp-2" title={session.title}>{session.title}</strong>
                          <p>{toProjectRelativePath(session.cwd, session.projectPath)}</p>
                        </div>
                        <div className="session-browser-meta">
                          <span>{formatDateTime(session.updatedAt)}</span>
                        </div>
                      </Link>

                      {includeSubagents && subagents.length > 0 ? (
                        <div className="session-subagent-list">
                          {subagents.map((subagent) => (
                            <Link
                              key={subagent.id}
                              to={`/sessions/projects/${subagent.projectId}/${subagent.id}`}
                              className="subagent-item"
                              >
                                <div className="subagent-item-main">
                                  <span className="subagent-item-icon" aria-hidden="true">
                                    <Bot size={14} strokeWidth={2.2} />
                                  </span>
                                  <div className="subagent-item-copy">
                                    <strong className="title-clamp-2" title={formatSubagentLabel(subagent)}>
                                      {formatSubagentLabel(subagent)}
                                    </strong>
                                    <p>{subagent.title}</p>
                                  </div>
                                </div>
                              <span className="subagent-item-time">{formatDateTime(subagent.updatedAt)}</span>
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {includeSubagents && groupedSessions.orphans.length > 0 ? (
                    <div className="orphan-subagent-block">
                      <p className="eyebrow">UNLINKED SUBAGENTS</p>
                      <div className="session-subagent-list">
                        {groupedSessions.orphans.map((subagent) => (
                          <Link
                            key={subagent.id}
                            to={`/sessions/projects/${subagent.projectId}/${subagent.id}`}
                            className="subagent-item"
                          >
                            <div className="subagent-item-main">
                              <span className="subagent-item-icon" aria-hidden="true">
                                <Bot size={14} strokeWidth={2.2} />
                              </span>
                              <div className="subagent-item-copy">
                                <strong className="title-clamp-2" title={formatSubagentLabel(subagent)}>
                                  {formatSubagentLabel(subagent)}
                                </strong>
                                <p>{subagent.title}</p>
                              </div>
                            </div>
                            <span className="subagent-item-time">{formatDateTime(subagent.updatedAt)}</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="state-box">세션 없음</div>
              )
            ) : (
              <div className="state-box">프로젝트 없음</div>
            )}
          </AsyncPane>
        </Panel>
      </div>
    );
  }

  const detailData = detail.data;
  const detailTitle = detailData ? formatSessionHeading(detailData) : "";
  const subagentRoleCounts = detailData ? summarizeSubagentRoles(detailData.subagents) : [];

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div className="heading-stack">
          <Link to="/sessions" className="back-link">
            <ArrowLeft size={14} strokeWidth={2.2} />
            프로젝트 목록
          </Link>
          <div className="session-breadcrumbs">
            {activeProject ? (
              <Link to={`/sessions/projects/${activeProject.id}`} className="breadcrumb-link">
                {activeProject.name}
              </Link>
            ) : null}
            <p className="heading-subtle">{activeProject?.path ?? params.projectId}</p>
          </div>
        </div>
      </section>

      <Panel
        title="Conversation"
        subtitle="사용자와 에이전트 대화"
        icon={<MessagesSquare size={16} strokeWidth={2.2} />}
        actions={(
          <div className="panel-badges">
            <button className="ghost-button" onClick={() => setShowActivity((prev) => !prev)}>
              <Bot size={14} strokeWidth={2.2} />
              {showActivity ? "작업 이벤트 숨기기" : "작업 이벤트 보기"}
            </button>
            <button className="ghost-button" onClick={() => setShowTechnical((prev) => !prev)}>
              <SlidersHorizontal size={14} strokeWidth={2.2} />
              {showTechnical ? "기술 로그 숨기기" : "기술 로그 보기"}
            </button>
          </div>
        )}
      >
        <AsyncPane
          loading={detail.initialLoading || (!activeProject && projects.initialLoading)}
          error={detail.error ?? projects.error}
          hasData={detail.hasData || projects.hasData}
        >
          {detailData ? (
            <div className="detail-stack">
              {detailData.isSubagent && detailData.parentSessionId ? (
                <div className="subagent-banner">
                  <div className="subagent-banner-copy">
                    <span className="subagent-banner-badge">SUBAGENT</span>
                    <p>{formatSubagentLabel(detailData)}</p>
                  </div>
                  <Link
                    to={`/sessions/projects/${detailData.projectId}/${detailData.parentSessionId}`}
                    className="back-link"
                  >
                    부모 세션: {detailData.parentSessionTitle ?? "세션"}
                  </Link>
                </div>
              ) : null}

              <div className="detail-hero conversation-hero">
                <div>
                  <p className="eyebrow">{detailData.isSubagent ? "SUBAGENT" : "THREAD"}</p>
                  <h3>{detailTitle}</h3>
                  <p>
                    {detailData.isSubagent
                      ? detailData.title
                      : toProjectRelativePath(detailData.cwd, detailData.projectPath)}
                  </p>
                </div>
                <div className="detail-meta">
                  <span>{detailData.modelProvider}</span>
                  <span>{detailData.memoryMode}</span>
                  <span>업데이트 {formatDateTime(detailData.updatedAt)}</span>
                </div>
              </div>

              {!detailData.isSubagent && detailData.subagents.length > 0 ? (
                <div className="subagent-summary-card">
                  <div className="subagent-summary-header">
                    <div>
                      <p className="eyebrow">SUBAGENTS</p>
                      <h4>하위 작업 {detailData.subagents.length}개</h4>
                    </div>
                    <button className="ghost-button" onClick={() => setShowSubagentSummary((prev) => !prev)}>
                      <ChevronDown
                        size={14}
                        strokeWidth={2.2}
                        className={showSubagentSummary ? "chevron-open" : "chevron-closed"}
                      />
                      {showSubagentSummary ? "접기" : "펼치기"}
                    </button>
                  </div>

                  <div className="subagent-role-row">
                    {subagentRoleCounts.map(([role, count]) => (
                      <span key={role} className="subagent-role-pill">
                        {role} {count}
                      </span>
                    ))}
                  </div>

                  {showSubagentSummary ? (
                    <div className="subagent-summary-list">
                      {detailData.subagents.map((subagent) => (
                        <Link
                          key={subagent.id}
                          to={`/sessions/projects/${detailData.projectId}/${subagent.id}`}
                          className="subagent-item"
                        >
                          <div className="subagent-item-main">
                            <span className="subagent-item-icon" aria-hidden="true">
                              <Bot size={14} strokeWidth={2.2} />
                            </span>
                            <div className="subagent-item-copy">
                              <strong>{formatSubagentLabel(subagent)}</strong>
                              <p>{subagent.title}</p>
                            </div>
                          </div>
                          <span className="subagent-item-time">{formatDateTime(subagent.updatedAt)}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <SessionTimeline items={detailData.timeline} showActivity={showActivity} showTechnical={showTechnical} />
            </div>
          ) : (
            <div className="state-box">세션 없음</div>
          )}
        </AsyncPane>
      </Panel>
    </div>
  );
}

function toProjectRelativePath(cwd: string, projectPath: string): string {
  if (cwd === projectPath) {
    return ".";
  }

  const prefix = `${projectPath}/`;
  if (cwd.startsWith(prefix)) {
    return cwd.slice(prefix.length);
  }

  return cwd;
}

function formatSessionHeading(session: SessionDetail | SessionListItem): string {
  return session.isSubagent ? formatSubagentLabel(session) : session.title;
}

function formatSubagentLabel(session: {
  subagentNickname: string | null;
  subagentRole: string | null;
}): string {
  const nickname = session.subagentNickname ?? "Subagent";
  const role = session.subagentRole ?? "worker";
  return `${nickname} · ${role}`;
}

function summarizeSubagentRoles(subagents: SubagentSummary[]): Array<[string, number]> {
  const counts = new Map<string, number>();

  for (const subagent of subagents) {
    const role = subagent.subagentRole ?? "subagent";
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}
