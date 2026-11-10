import { useState, useEffect, useCallback, useMemo } from 'react';
import { CompleteSessionSummary } from '../../../shared/types';
import { fetchCompleteSessionSummary } from '../../../infrastructure/api/api';

export type PostSessionSection = 'overview' | 'summary_points' | 'members' | 'topics';

export interface SubTopicItem {
  id: string;
  title: string;
  category: string;
  key_points: string[];
}

export const SUB_TOPICS_STATIC_DATA: SubTopicItem[] = [
  {
    id: "Sub-Topic 1",
    title: "Digital Classrooms & Rural Optical Fiber Infrastructure",
    category: "Digital Infrastructure",
    key_points: [
      "Broadband Grid Integration: Mandates high-speed optic fiber connectivity across all district secondary schools within the upcoming fiscal cycle.",
      "STEM Laboratory Grants: Establishes 70:30 central-state matching grants to fund interactive digital computing and science laboratories in 50,000 rural institutions.",
      "Vernacular Learning Repositories: Directs national academic councils to deploy unified digital curricular repositories accessible in 22 official regional languages.",
      "Renewable Power Backups: Mandates dedicated solar micro-grid installations with battery storage for schools with unstable regional electrical grids."
    ]
  },
  {
    id: "Sub-Topic 2",
    title: "Student Data Sovereignty, Biometric Privacy & AI Ethics",
    category: "Data Privacy & AI",
    key_points: [
      "Domestic Sovereign Cloud Storage: Enforces strict domestic data residency with zero-trust cryptographic encryption for all educational repositories.",
      "Independent Algorithmic Audits: Establishes a statutory ethics panel to conduct mandatory biannual safety and bias audits on automated tutoring systems.",
      "Prohibition on Commercial Profiling: Bars commercial EdTech providers from collecting, monetizing, or profiling student psychometric and behavioral data.",
      "Parental Consent Architecture: Mandates granular parental consent workflows and verified one-click student data erasure rights across digital tools."
    ]
  },
  {
    id: "Sub-Topic 3",
    title: "Teacher Training Grants, Pedagogical Upskilling & EdTech Fellowships",
    category: "Teacher Capacity",
    key_points: [
      "National Digital Pedagogical Fellowship: Institutes a continuous professional development framework for 1.2 million public school educators.",
      "Quarterly Educator Stipends: Allocates dedicated pedagogical grants for teachers completing accredited digital classroom leadership modules.",
      "District Technical Support Pods: Deploys mobile technical support teams to assist teachers with hardware maintenance and software troubleshooting.",
      "Peer-Led Courseware Libraries: Establishes state-level repositories where certified teachers can publish and peer-review interactive digital lesson plans."
    ]
  },
  {
    id: "Sub-Topic 4",
    title: "Domestic Hardware Manufacturing & Localized Maintenance Hubs",
    category: "Hardware Manufacturing",
    key_points: [
      "Production-Linked Incentives (PLI): Introduces targeted tariff exemptions to incentivize domestic fabrication of durable, low-power classroom tablets.",
      "Rapid District Maintenance Consortia: Establishes regional repair hubs ensuring guaranteed 48-hour hardware replacement and zero classroom downtime.",
      "Mandatory 5-Year Hardware Lifecycles: Enforces binding 5-year comprehensive hardware warranties and localized spare battery replacement guarantees.",
      "Apprenticeship Vocational Partnerships: Partners with regional polytechnic institutes to train vocational apprentices in classroom device maintenance."
    ]
  },
  {
    id: "Sub-Topic 5",
    title: "Fiscal Allocations, Transparent Auditing & Milestone Disbursals",
    category: "Fiscal Oversight",
    key_points: [
      "Direct Treasury Fund Disbursals: Directs digital treasury transfers to bypass administrative bottlenecks, expediting district project funding.",
      "Real-Time Public Expenditure Dashboard: Mandates an open online portal tracking school-by-school capital expenditures against scheduled milestones.",
      "Statutory Parliamentary Tranche Audits: Requires joint legislative committee clearance of expenditure reports prior to releasing subsequent funding tranches.",
      "Unspent Fund Recovery Mechanisms: Institutes automatic clawback provisions for municipal allocations unused after 12 consecutive months."
    ]
  }
];

export const POINT_CATEGORIES = [
  "ALL",
  "Digital Infrastructure",
  "Data Privacy & AI",
  "Teacher Capacity",
  "Hardware Manufacturing",
  "Fiscal Oversight"
];

export function usePostSessionViewModel() {
  const [summaryData, setSummaryData] = useState<CompleteSessionSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState("");
  const [activeSection, setActiveSection] = useState<PostSessionSection>("overview");
  const [pointCategoryFilter, setPointCategoryFilter] = useState("ALL");
  const [pointSearchQuery, setPointSearchQuery] = useState("");

  const loadSummary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchCompleteSessionSummary();
      setSummaryData(data);
    } catch (err: any) {
      console.error("Failed to load complete session summary:", err);
      setError(err?.message || "Failed to load complete session summary. Please check connection.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const handleExportJSON = () => {
    if (!summaryData) return;
    const blob = new Blob([JSON.stringify(summaryData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PARLIAMENTARY_REPORT_${summaryData.session_information.session_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  const filteredMembers = useMemo(() => {
    if (!summaryData) return [];
    return summaryData.member_wise_summary.filter((m) =>
      m.name.toLowerCase().includes(memberFilter.toLowerCase()) ||
      m.seat_id.toLowerCase().includes(memberFilter.toLowerCase()) ||
      m.member_id.toLowerCase().includes(memberFilter.toLowerCase()) ||
      (m.member_summary?.discussion_summary &&
        m.member_summary.discussion_summary.toLowerCase().includes(memberFilter.toLowerCase())) ||
      (m.member_summary?.policy_keywords &&
        m.member_summary.policy_keywords.some((k) => k.toLowerCase().includes(memberFilter.toLowerCase())))
    );
  }, [summaryData, memberFilter]);

  const filteredSubTopics = useMemo(() => {
    return SUB_TOPICS_STATIC_DATA.filter((item) => {
      const matchesCat = pointCategoryFilter === "ALL" || item.category === pointCategoryFilter;
      const matchesQuery =
        pointSearchQuery === "" ||
        item.title.toLowerCase().includes(pointSearchQuery.toLowerCase()) ||
        item.id.toLowerCase().includes(pointSearchQuery.toLowerCase()) ||
        item.key_points.some((p) => p.toLowerCase().includes(pointSearchQuery.toLowerCase()));
      return matchesCat && matchesQuery;
    });
  }, [pointCategoryFilter, pointSearchQuery]);

  return {
    summaryData,
    isLoading,
    error,
    memberFilter,
    setMemberFilter,
    activeSection,
    setActiveSection,
    pointCategoryFilter,
    setPointCategoryFilter,
    pointSearchQuery,
    setPointSearchQuery,
    filteredMembers,
    filteredSubTopics,
    loadSummary,
    handleExportJSON,
    handlePrint
  };
}

export type PostSessionViewModel = ReturnType<typeof usePostSessionViewModel>;
