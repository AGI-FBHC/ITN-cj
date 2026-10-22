// Recovered from the 2026-08-03 deployment, not the lost original TSX.
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
  useParams,
  Link,
  NavLink,
} from "react-router-dom";
import {
  api,
  bootstrap,
  clearLearningSession,
  generateLearningPlan,
  getLearnerMemory,
  LoadPanel,
  persistState,
  refreshLearning,
  saveProfile,
  SyncStatus,
  updateLearnerCustomMemory,
  useLearning,
  useLesson,
} from "./learning-api.jsx";
import LoginPage from "./LoginPage.jsx";
import { orgShortName } from "./org-brand.js";
import { useOrgBrand } from "./BrandText.jsx";
import Markdown from "./admin/Markdown.jsx";
import CoursewareReferences, { CoursewareMarkdown } from "./CoursewareReferences.jsx";
import { lessonReferences } from "./courseware-references.js";
import PresentationArtifact from "./PresentationArtifact.jsx";
import TutorChat from "./TutorChat.jsx";
import { askTutor } from "./tutor.js";
import SystemLogo from "./SystemLogo.jsx";
import { LearningPlanPanel } from "./learning-plan.jsx";
import { LearningActivityGrid, PopularLearningResources, useDashboardInsights } from "./HomeLearningWidgets.jsx";
import { RESOURCE_OPTIONS, resourceTypes, lessonSections, lessonSlides, ChapterCompletion } from "./LearnerResources.jsx";
import "./lesson-start-modal.css";
function ProductLogo({ className: n = "", animated: r = !1, color: u = "#111318" }) {
  const src = useOrgBrand()?.logoUrl;
  if (!src) return jsxRuntime.jsx(SystemLogo, { className: n });
  return jsxRuntime.jsx("img", {
    "code-path": "src\\components\\ProductLogo.tsx:12:5",
    src,
    alt: "",
    "aria-hidden": !0,
    className: n,
    style: { objectFit: "contain" },
  });
}

function Navbar({ onGetStarted: n }) {
  return jsxRuntime.jsx("header", {
    "code-path": "src\\components\\Navbar.tsx:5:5",
    className:
      "sticky top-0 z-50 w-full bg-white/90 backdrop-blur border-b border-black/5",
    children: jsxRuntime.jsxs("div", {
      "code-path": "src\\components\\Navbar.tsx:6:7",
      className:
        "mx-auto flex h-16 max-w-6xl items-center justify-between px-6",
      children: [
        jsxRuntime.jsxs("a", {
          "code-path": "src\\components\\Navbar.tsx:7:9",
          href: "#hero",
          className: "flex items-center gap-2.5 select-none",
          children: [
            jsxRuntime.jsx(SystemLogo, {
              "code-path": "src\\components\\Navbar.tsx:8:11",
              className: "h-8 w-8",
            }),
            jsxRuntime.jsx("span", {
              "code-path": "src\\components\\Navbar.tsx:9:11",
              className: "text-xl font-extrabold tracking-wide text-[#111318]",
              children: "智训云枢",
            }),
          ],
        }),
        jsxRuntime.jsxs("div", {
          className: "flex items-center gap-3",
          children: [
            jsxRuntime.jsx("button", {
              "code-path": "src\\components\\Navbar.tsx:12:9",
              onClick: n,
              className:
                "rounded-full bg-[#6c0ef2] px-5 py-2.5 text-sm font-extrabold text-white shadow-[0_4px_14px_rgba(108,14,242,0.35)] transition-all hover:-translate-y-0.5 hover:bg-[#5a0bd2] hover:shadow-[0_8px_20px_rgba(108,14,242,0.45)] active:translate-y-0",
              children: "开始学习",
            }),
          ],
        }),
      ],
    }),
  });
}

function Bb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:21:5",
    viewBox: "0 0 120 64",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:22:7",
        d: "M30 32c0-11 9-20 20-20 8 0 14 5 17 12 2 5 3 8 3 8s1-3 3-8c3-7 9-12 17-12 11 0 20 9 20 20s-9 20-20 20c-8 0-14-5-17-12-2-5-3-8-3-8s-1 3-3 8c-3 7-9 12-17 12-11 0-20-9-20-20Z",
        stroke: "#101014",
        strokeWidth: "11",
        strokeLinecap: "round",
        transform: "translate(-5 0) scale(0.92)",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:29:7",
        d: "M30 32c0-11 9-20 20-20 8 0 14 5 17 12",
        stroke: "#4f8ef7",
        strokeWidth: "7",
        strokeLinecap: "round",
        transform: "translate(-5 0) scale(0.92)",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:36:7",
        d: "M67 24c2 5 3 8 3 8s1-3 3-8c3-7 9-12 17-12",
        stroke: "#ffd23f",
        strokeWidth: "7",
        strokeLinecap: "round",
        transform: "translate(-5 0) scale(0.92)",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:43:7",
        d: "M110 32c0 11-9 20-20 20-8 0-14-5-17-12",
        stroke: "#f4506a",
        strokeWidth: "7",
        strokeLinecap: "round",
        transform: "translate(-5 0) scale(0.92)",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:50:7",
        d: "M50 52c-11 0-20-9-20-20",
        stroke: "#3ec6a4",
        strokeWidth: "7",
        strokeLinecap: "round",
        transform: "translate(-5 0) scale(0.92)",
      }),
    ],
  });
}

function Hb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:63:5",
    viewBox: "0 0 96 96",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:64:7",
        cx: "42",
        cy: "54",
        r: "34",
        fill: "#fff",
        stroke: "#101014",
        strokeWidth: "3.5",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:65:7",
        cx: "42",
        cy: "54",
        r: "25",
        fill: "#4f8ef7",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:66:7",
        cx: "42",
        cy: "54",
        r: "16",
        fill: "#fff",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:67:7",
        cx: "42",
        cy: "54",
        r: "8",
        fill: "#4f8ef7",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:68:7",
        d: "M52 44 86 12",
        stroke: "#e8a33d",
        strokeWidth: "4.5",
        strokeLinecap: "round",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:69:7",
        d: "M86 12l-9 2 6.5-6.5L86 12Z",
        fill: "#e8a33d",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:70:7",
        d: "M86 12l-3 9 9-2.5L86 12Z",
        fill: "#e8a33d",
      }),
    ],
  });
}

function Gb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:77:5",
    viewBox: "0 0 100 100",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:78:7",
        d: "M50 4 90 26v48L50 96 10 74V26L50 4Z",
        fill: "#ffd23f",
        stroke: "#101014",
        strokeWidth: "3",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:85:7",
        cx: "50",
        cy: "34",
        r: "7",
        fill: "#101014",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:86:7",
        d: "M50 44v18m0-14-14 6m14-6 14 6m-14 4-9 16m9-16 9 16",
        stroke: "#101014",
        strokeWidth: "4.5",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ],
  });
}

function qb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:99:5",
    viewBox: "0 0 100 100",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:100:7",
        d: "M50 4 90 26v48L50 96 10 74V26L50 4Z",
        fill: "#4f6df5",
        stroke: "#101014",
        strokeWidth: "3",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:107:7",
        d: "M38 38 26 50l12 12M62 38l12 12-12 12M55 32 45 68",
        stroke: "#fff",
        strokeWidth: "5",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ],
  });
}

function Qb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:120:5",
    viewBox: "0 0 100 100",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:121:7",
        d: "M50 4 90 26v48L50 96 10 74V26L50 4Z",
        fill: "#101014",
        stroke: "#101014",
        strokeWidth: "3",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:128:7",
        cx: "42",
        cy: "34",
        r: "9",
        fill: "#f4506a",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:129:7",
        cx: "58",
        cy: "34",
        r: "9",
        fill: "#ff8a3d",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:130:7",
        cx: "42",
        cy: "51",
        r: "9",
        fill: "#a259ff",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:131:7",
        cx: "58",
        cy: "51",
        r: "9",
        fill: "#4f8ef7",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:132:7",
        cx: "42",
        cy: "68",
        r: "9",
        fill: "#3ec6a4",
      }),
    ],
  });
}

function Yb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:139:5",
    viewBox: "0 0 110 90",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:140:7",
        d: "M20 78 44 22l24 56M30 58h28",
        stroke: "#101014",
        strokeWidth: "6",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:147:7",
        d: "M88 30c0 8-2 12-10 14 8 2 10 6 10 14 0-8 2-12 10-14-8-2-10-6-10-14Z",
        fill: "#ffd23f",
        stroke: "#101014",
        strokeWidth: "2.5",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("rect", {
        "code-path": "src\\components\\Doodles.tsx:154:7",
        x: "72",
        y: "58",
        width: "26",
        height: "22",
        rx: "6",
        fill: "#f4506a",
        stroke: "#101014",
        strokeWidth: "2.5",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:155:7",
        d: "M78 74l8-10 6 8",
        stroke: "#fff",
        strokeWidth: "3.5",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ],
  });
}

function Vb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:162:5",
    viewBox: "0 0 80 80",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("rect", {
        "code-path": "src\\components\\Doodles.tsx:163:7",
        x: "8",
        y: "8",
        width: "64",
        height: "64",
        rx: "14",
        fill: "#fff",
        stroke: "#101014",
        strokeWidth: "3.5",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:164:7",
        d: "M24 42l12 12 22-26",
        stroke: "#6c0ef2",
        strokeWidth: "7",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ],
  });
}

function Xb({ className: n = "" }) {
  return jsxRuntime.jsx("svg", {
    "code-path": "src\\components\\Doodles.tsx:171:5",
    viewBox: "0 0 48 48",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: jsxRuntime.jsx("path", {
      "code-path": "src\\components\\Doodles.tsx:172:7",
      d: "M8 6l30 18-15 3-7 14L8 6Z",
      fill: "#fff",
      stroke: "#101014",
      strokeWidth: "3",
      strokeLinejoin: "round",
    }),
  });
}

function Zb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:185:5",
    viewBox: "0 0 120 110",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("rect", {
        "code-path": "src\\components\\Doodles.tsx:186:7",
        x: "14",
        y: "10",
        width: "72",
        height: "54",
        rx: "10",
        fill: "#fff",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:187:7",
        d: "M14 26h72",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:188:7",
        cx: "24",
        cy: "18",
        r: "3",
        fill: "#f4506a",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:189:7",
        cx: "34",
        cy: "18",
        r: "3",
        fill: "#ffd23f",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:190:7",
        cx: "44",
        cy: "18",
        r: "3",
        fill: "#3ec6a4",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:191:7",
        d: "M26 38h34M26 48h22",
        stroke: "#c9ccd6",
        strokeWidth: "5",
        strokeLinecap: "round",
      }),
      jsxRuntime.jsx("rect", {
        "code-path": "src\\components\\Doodles.tsx:192:7",
        x: "46",
        y: "48",
        width: "62",
        height: "46",
        rx: "10",
        fill: "#6c0ef2",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:193:7",
        d: "M46 62h62",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:194:7",
        cx: "56",
        cy: "55",
        r: "3",
        fill: "#fff",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:195:7",
        d: "M58 74h34M58 84h22",
        stroke: "#c9a6ff",
        strokeWidth: "5",
        strokeLinecap: "round",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:196:7",
        cx: "98",
        cy: "88",
        r: "14",
        fill: "#ffd23f",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:197:7",
        cx: "94",
        cy: "85",
        r: "2.4",
        fill: "#101014",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:198:7",
        cx: "102",
        cy: "85",
        r: "2.4",
        fill: "#101014",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:199:7",
        d: "M93 93c3 3 7 3 10 0",
        stroke: "#101014",
        strokeWidth: "2.6",
        strokeLinecap: "round",
      }),
    ],
  });
}

function Kb({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:206:5",
    viewBox: "0 0 90 90",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:207:7",
        d: "M45 6 80 24v30L45 84 10 54V24L45 6Z",
        fill: "#ffd23f",
        stroke: "#101014",
        strokeWidth: "3",
        strokeLinejoin: "round",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:214:7",
        cx: "45",
        cy: "38",
        r: "7",
        fill: "#101014",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:215:7",
        d: "M45 47v12m0-9-11 5m11-5 11 5",
        stroke: "#101014",
        strokeWidth: "4",
        strokeLinecap: "round",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:216:7",
        d: "M26 14c0 6-1.6 9-7.5 10.5C24.4 26 26 29 26 35c0-6 1.6-9 7.5-10.5C27.6 23 26 20 26 14Z",
        fill: "#fff",
        stroke: "#101014",
        strokeWidth: "2",
        strokeLinejoin: "round",
      }),
    ],
  });
}

function $b({ className: n = "" }) {
  return jsxRuntime.jsxs("svg", {
    "code-path": "src\\components\\Doodles.tsx:229:5",
    viewBox: "0 0 100 60",
    className: n,
    fill: "none",
    "aria-hidden": !0,
    children: [
      jsxRuntime.jsx("rect", {
        "code-path": "src\\components\\Doodles.tsx:230:7",
        x: "4",
        y: "6",
        width: "70",
        height: "48",
        rx: "24",
        fill: "#ffd23f",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("circle", {
        "code-path": "src\\components\\Doodles.tsx:231:7",
        cx: "28",
        cy: "30",
        r: "12",
        fill: "#fff",
        stroke: "#101014",
        strokeWidth: "3",
      }),
      jsxRuntime.jsx("path", {
        "code-path": "src\\components\\Doodles.tsx:232:7",
        d: "M70 54c10-4 18-12 22-24",
        stroke: "#101014",
        strokeWidth: "3.5",
        strokeLinecap: "round",
      }),
    ],
  });
}

const Jb = [
  {
    Icon: Kb,
    style: { top: "6%", left: "1.5%" },
    size: "w-20 md:w-24",
    anim: "anim-float",
    delay: 0.1,
    floatDelay: 0,
    depth: 18,
    hideOnMobile: !0,
  },
  {
    Icon: Bb,
    style: { top: "14%", left: "11%" },
    size: "w-24 md:w-32",
    anim: "anim-float-alt",
    delay: 0.25,
    floatDelay: 0.6,
    depth: 26,
  },
  {
    Icon: Hb,
    style: { top: "44%", left: "2.5%" },
    size: "w-20 md:w-28",
    anim: "anim-float-sway",
    delay: 0.4,
    floatDelay: 1.1,
    depth: 34,
  },
  {
    Icon: Qb,
    style: { top: "66%", left: "11%" },
    size: "w-16 md:w-24",
    anim: "anim-float",
    delay: 0.55,
    floatDelay: 0.3,
    depth: 22,
  },
  {
    Icon: Vb,
    style: { top: "82%", left: "1%" },
    size: "w-14 md:w-20",
    anim: "anim-float-alt",
    delay: 0.7,
    floatDelay: 1.5,
    depth: 30,
    hideOnMobile: !0,
  },
  {
    Icon: $b,
    style: { top: "90%", left: "7%" },
    size: "w-16 md:w-24",
    anim: "anim-float-sway",
    delay: 0.8,
    floatDelay: 0.9,
    depth: 16,
    hideOnMobile: !0,
  },
  {
    Icon: Gb,
    style: { top: "10%", right: "6%" },
    size: "w-16 md:w-24",
    anim: "anim-float-alt",
    delay: 0.2,
    floatDelay: 0.4,
    depth: 24,
  },
  {
    Icon: qb,
    style: { top: "34%", right: "0.5%" },
    size: "w-16 md:w-24",
    anim: "anim-float",
    delay: 0.35,
    floatDelay: 1.2,
    depth: 32,
    hideOnMobile: !0,
  },
  {
    Icon: Yb,
    style: { top: "52%", right: "7%" },
    size: "w-20 md:w-28",
    anim: "anim-float-sway",
    delay: 0.5,
    floatDelay: 0.2,
    depth: 20,
  },
  {
    Icon: Zb,
    style: { top: "74%", right: "14%" },
    size: "w-24 md:w-32",
    anim: "anim-float",
    delay: 0.65,
    floatDelay: 0.8,
    depth: 28,
  },
  {
    Icon: Xb,
    style: { bottom: "4%", left: "52%" },
    size: "w-8 md:w-10",
    anim: "anim-float-alt",
    delay: 0.9,
    floatDelay: 0.5,
    depth: 40,
  },
];

function Hero({ onGetStarted: n }) {
  const r = React.useRef(null),
    [u, i] = React.useState({ x: 0, y: 0 }),
    d = (p) => {
      const m = r.current?.getBoundingClientRect();
      if (!m) return;
      const b = (p.clientX - m.left) / m.width - 0.5,
        h = (p.clientY - m.top) / m.height - 0.5;
      i({ x: b, y: h });
    };
  return jsxRuntime.jsxs("section", {
    "code-path": "src\\sections\\Hero.tsx:58:5",
    id: "hero",
    ref: r,
    onMouseMove: d,
    onMouseLeave: () => i({ x: 0, y: 0 }),
    className:
      "relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden bg-[#f3f4f6]",
    children: [
      Jb.map(
        (
          {
            Icon: p,
            style: m,
            size: b,
            anim: h,
            delay: x,
            floatDelay: y,
            depth: j,
            hideOnMobile: z,
          },
          R,
        ) =>
          jsxRuntime.jsx(
            "div",
            {
              "code-path": "src\\sections\\Hero.tsx:67:9",
              className: `pointer-events-none absolute z-0 ${z ? "hidden md:block" : ""}`,
              style: {
                ...m,
                transform: `translate(${u.x * j}px, ${u.y * j}px)`,
                transition: "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
              },
              children: jsxRuntime.jsx("div", {
                "code-path": "src\\sections\\Hero.tsx:76:11",
                className: "anim-pop-in",
                style: { animationDelay: `${x}s` },
                children: jsxRuntime.jsx("div", {
                  "code-path": "src\\sections\\Hero.tsx:77:13",
                  className: h,
                  style: { animationDelay: `${y}s` },
                  children: jsxRuntime.jsx(p, {
                    "code-path": "src\\sections\\Hero.tsx:78:15",
                    className: `${b} drop-shadow-sm`,
                  }),
                }),
              }),
            },
            R,
          ),
      ),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\sections\\Hero.tsx:85:7",
        className: "relative z-10 mx-auto max-w-3xl px-6 text-center",
        children: [
          jsxRuntime.jsxs("h1", {
            "code-path": "src\\sections\\Hero.tsx:86:9",
            className:
              "anim-rise-in text-4xl font-black leading-[1.3] tracking-tight text-[#101014] md:text-6xl",
            style: { animationDelay: "0.15s" },
            children: [
              "你的 AI 学习搭档",
              jsxRuntime.jsx("br", {
                "code-path": "src\\sections\\Hero.tsx:91:11",
              }),
              jsxRuntime.jsx("span", {
                "code-path": "src\\sections\\Hero.tsx:92:11",
                className: "text-[#6c0ef2]",
                children: "懂课程，也懂你。",
              }),
            ],
          }),
          jsxRuntime.jsxs("p", {
            "code-path": "src\\sections\\Hero.tsx:95:9",
            className:
              "anim-rise-in mx-auto mt-6 max-w-xl text-lg font-semibold leading-relaxed text-[#5b5e6b]",
            style: { animationDelay: "0.35s" },
            children: [
              "多智能体协同诊断学习状态、生成个性化资源，",
              jsxRuntime.jsx("br", {
                "code-path": "src\\sections\\Hero.tsx:100:11",
              }),
              "并在每次练习与反馈中不断修正下一步学习路径。",
            ],
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\sections\\Hero.tsx:104:9",
            className: "anim-rise-in mt-10",
            style: { animationDelay: "0.55s" },
            children: jsxRuntime.jsxs("button", {
              "code-path": "src\\sections\\Hero.tsx:105:11",
              onClick: n,
              className:
                "anim-pulse-ring group relative rounded-full bg-[#6c0ef2] px-10 py-4 text-lg font-extrabold text-white shadow-[0_8px_24px_rgba(108,14,242,0.4)] transition-all hover:-translate-y-1 hover:bg-[#5a0bd2] hover:shadow-[0_14px_32px_rgba(108,14,242,0.5)] active:translate-y-0",
              children: [
                "立即体验",
                jsxRuntime.jsx("span", {
                  "code-path": "src\\sections\\Hero.tsx:110:13",
                  className:
                    "ml-2 inline-block transition-transform group-hover:translate-x-1",
                  children: "→",
                }),
              ],
            }),
          }),
        ],
      }),
    ],
  });
}

function Footer() {
  return jsxRuntime.jsxs("footer", {
    "code-path": "src\\sections\\Footer.tsx:5:5",
    id: "footer",
    className:
      "relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#0d0d16] text-white",
    children: [
      jsxRuntime.jsx("div", {
        "code-path": "src\\sections\\Footer.tsx:10:7",
        className:
          "pointer-events-none absolute left-1/2 top-1/2 h-[480px] w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#6c0ef2]/20 blur-[120px]",
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\sections\\Footer.tsx:12:7",
        className: "anim-pop-in relative z-10 flex flex-col items-center",
        style: { animationDelay: "0.1s" },
        children: [
          jsxRuntime.jsx(SystemLogo, {
            "code-path": "src\\sections\\Footer.tsx:13:9",
            className: "h-32 w-32 md:h-44 md:w-44",
            tone: "light",
          }),
          jsxRuntime.jsx("h2", {
            "code-path": "src\\sections\\Footer.tsx:14:9",
            className:
              "mt-10 text-4xl font-extrabold tracking-[0.2em] md:text-5xl",
            children: "智训云枢",
          }),
          jsxRuntime.jsx("p", {
            "code-path": "src\\sections\\Footer.tsx:15:9",
            className:
              "mt-4 text-sm font-semibold tracking-[0.35em] text-white/40",
            children: "ZHIXUN YUNSHU",
          }),
        ],
      }),
    ],
  });
}

const Bi = [
    {
      key: "profile",
      title: "分析学习画像",
      subtitle: "正在解读你的目标与基础…",
      art: "profile",
    },
    {
      key: "path",
      title: "规划学习路径",
      subtitle: "正在构建课程顺序与里程碑…",
      art: "path",
    },
    {
      key: "content",
      title: "生成学习内容",
      subtitle: "正在创建讲解、练习与测验…",
      art: "content",
    },
  ],
  Fb = 2600;

function Ib({ chips: n }) {
  const r = n.slice(0, 4);
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\components\\GeneratingPlan.tsx:24:5",
    className:
      "gen-float w-52 rounded-2xl border border-[#e6dcfd] bg-white p-4 shadow-[0_16px_40px_rgba(108,14,242,0.14)]",
    children: [
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:25:7",
        className: "gen-bar h-2.5 w-16 rounded-full bg-[#6c0ef2]/25",
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:26:7",
        className: "mt-3 flex flex-wrap gap-2",
        children: [
          r.map((u, i) =>
            jsxRuntime.jsx(
              "span",
              {
                "code-path": "src\\components\\GeneratingPlan.tsx:28:11",
                className:
                  "gen-bar rounded-lg bg-[#f4effe] px-2.5 py-1 text-[11px] font-bold text-[#6c0ef2]",
                style: { animationDelay: `${i * 0.25}s` },
                children: u,
              },
              u,
            ),
          ),
          r.length === 0 &&
            jsxRuntime.jsxs(jsxRuntime.Fragment, {
              children: [
                jsxRuntime.jsx("span", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:38:13",
                  className: "gen-bar h-5 w-14 rounded-lg bg-[#f4effe]",
                }),
                jsxRuntime.jsx("span", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:39:13",
                  className: "gen-bar h-5 w-20 rounded-lg bg-[#f4effe]",
                  style: { animationDelay: "0.25s" },
                }),
                jsxRuntime.jsx("span", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:40:13",
                  className: "gen-bar h-5 w-12 rounded-lg bg-[#f4effe]",
                  style: { animationDelay: "0.5s" },
                }),
              ],
            }),
        ],
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:44:7",
        className: "mt-3 space-y-2",
        children: [
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:45:9",
            className: "gen-bar h-2 w-full rounded-full bg-black/10",
            style: { animationDelay: "0.3s" },
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:46:9",
            className: "gen-bar h-2 w-3/4 rounded-full bg-black/10",
            style: { animationDelay: "0.55s" },
          }),
        ],
      }),
    ],
  });
}

function e2({ subjects: n }) {
  const r = (n.length > 0 ? n : ["数据结构", "操作系统", "计算机网络"]).slice(
    0,
    4,
  );
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\components\\GeneratingPlan.tsx:55:5",
    className:
      "gen-float w-52 rounded-2xl border border-[#e6dcfd] bg-white p-4 shadow-[0_16px_40px_rgba(108,14,242,0.14)]",
    children: [
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:56:7",
        className: "gen-bar h-2.5 w-20 rounded-full bg-[#6c0ef2]/25",
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:57:7",
        className: "relative mt-4 space-y-3 pl-5",
        children: [
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:58:9",
            className:
              "absolute bottom-1.5 left-[5px] top-1.5 w-px bg-[#6c0ef2]/20",
          }),
          r.map((u, i) =>
            jsxRuntime.jsxs(
              "div",
              {
                "code-path": "src\\components\\GeneratingPlan.tsx:60:11",
                className: "gen-node relative flex items-center gap-2",
                style: { animationDelay: `${i * 0.7}s` },
                children: [
                  jsxRuntime.jsx("span", {
                    "code-path": "src\\components\\GeneratingPlan.tsx:61:13",
                    className:
                      "absolute -left-5 flex h-3 w-3 items-center justify-center rounded-full border-2 border-[#6c0ef2] bg-white",
                  }),
                  jsxRuntime.jsxs("span", {
                    "code-path": "src\\components\\GeneratingPlan.tsx:62:13",
                    className:
                      "rounded-lg bg-[#f4effe] px-2.5 py-1 text-[11px] font-bold text-[#6c0ef2]",
                    children: [i + 1, ". ", u],
                  }),
                ],
              },
              u,
            ),
          ),
        ],
      }),
    ],
  });
}

function t2() {
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\components\\GeneratingPlan.tsx:74:5",
    className:
      "gen-float w-52 rounded-2xl border border-[#e6dcfd] bg-white p-4 shadow-[0_16px_40px_rgba(108,14,242,0.14)]",
    children: [
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:75:7",
        className: "flex items-center justify-between",
        children: [
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:76:9",
            className: "gen-bar h-2.5 w-16 rounded-full bg-[#6c0ef2]/25",
          }),
          jsxRuntime.jsx("span", {
            "code-path": "src\\components\\GeneratingPlan.tsx:77:9",
            className:
              "rounded-md bg-[#ffd23f]/70 px-1.5 py-0.5 text-[9px] font-black text-[#8a6d00]",
            children: "NEW",
          }),
        ],
      }),
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:79:7",
        className: "mt-3 grid grid-cols-3 gap-2",
        children: ["讲解", "练习", "测验"].map((n, r) =>
          jsxRuntime.jsxs(
            "div",
            {
              "code-path": "src\\components\\GeneratingPlan.tsx:81:11",
              className: "gen-bar rounded-xl bg-[#f4effe] p-2 text-center",
              style: { animationDelay: `${r * 0.3}s` },
              children: [
                jsxRuntime.jsx("div", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:82:13",
                  className:
                    "mx-auto mb-1.5 h-6 w-6 rounded-lg bg-[#6c0ef2]/20",
                }),
                jsxRuntime.jsx("span", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:83:13",
                  className: "text-[10px] font-bold text-[#6c0ef2]",
                  children: n,
                }),
              ],
            },
            n,
          ),
        ),
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:87:7",
        className: "mt-3 space-y-2",
        children: [
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:88:9",
            className: "gen-bar h-2 w-full rounded-full bg-black/10",
            style: { animationDelay: "0.4s" },
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:89:9",
            className: "gen-bar h-2 w-2/3 rounded-full bg-black/10",
            style: { animationDelay: "0.7s" },
          }),
        ],
      }),
    ],
  });
}

function GeneratingPlan({ answers: n, onClose: r, onComplete: u }) {
  const [i, d] = React.useState(0),
    [p, m] = React.useState(!1);
  const [plan, setPlan] = React.useState(null);
  const [planError, setPlanError] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (p) return;
    const y = setTimeout(() => {
      i < Bi.length - 1 ? d((j) => j + 1) : m(!0);
    }, Fb);
    return () => clearTimeout(y);
  }, [i, p]);
  React.useEffect(() => {
    let alive = true;
    setPlanError("");
    const byTitle = (needle) => Object.values(n).find((entry) => (entry.title || "").includes(needle))?.items || [];
    const profilePayload = {
      roleLabel: (n.role?.items || byTitle("身份"))[0] || "",
      goalLabel: (n.goal?.items || byTitle("目标"))[0] || "",
      subjectValues: n.subjects?.items || byTitle("科目"),
      onboardingAnswers: n,
    };
    (async () => {
      try {
        await saveProfile(profilePayload);
      } catch (_) {
        // 资料保存失败不阻断计划生成：后端会读取已保存的画像。
      }
      try {
        const result = await generateLearningPlan();
        if (alive) setPlan(result?.plan || null);
      } catch (reason) {
        if (alive) setPlanError(reason?.message || "学习计划生成失败，请稍后重试");
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);
  const b = Bi[i],
    h = React.useMemo(
      () => Object.values(n).find((y) => y.key === "subjects" || y.title.includes("科目"))?.items ?? [],
      [n],
    ),
    x = React.useMemo(
      () => [
        ...(Object.values(n).find((y) => y.title.includes("目前"))?.items ??
          []),
        ...(Object.values(n).find(
          (y) => y.title.includes("目标") && !y.title.includes("时间"),
        )?.items ?? []),
        ...(Object.values(n).find((y) => y.title.includes("技术"))?.items ??
          []),
      ],
      [n],
    );
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\components\\GeneratingPlan.tsx:134:5",
    className:
      "fixed inset-0 z-[110] flex flex-col bg-gradient-to-br from-[#eef2ff] via-white to-[#f3eaff]",
    children: [
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:136:7",
        className: "px-6 pt-6",
        children: jsxRuntime.jsx("button", {
          "code-path": "src\\components\\GeneratingPlan.tsx:137:9",
          onClick: r,
          className:
            "flex items-center gap-2 rounded-full px-3 py-2 text-sm font-bold text-[#111318] transition-colors hover:bg-black/5",
          children: "← 返回首页",
        }),
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\GeneratingPlan.tsx:146:7",
        className: "flex flex-1 flex-col items-center justify-center px-6",
        children: [
          jsxRuntime.jsxs("div", {
            "code-path": "src\\components\\GeneratingPlan.tsx:147:9",
            className:
              "w-full max-w-xl rounded-3xl border border-black/5 bg-white/90 px-8 py-12 text-center shadow-[0_32px_80px_rgba(76,29,149,0.12)] backdrop-blur",
            children: [
              jsxRuntime.jsx("div", {
                "code-path": "src\\components\\GeneratingPlan.tsx:149:11",
                className:
                  "mx-auto flex w-32 items-center justify-center gap-1.5",
                children: Bi.map((y, j) =>
                  jsxRuntime.jsx(
                    "span",
                    {
                      "code-path": "src\\components\\GeneratingPlan.tsx:151:15",
                      className: `h-1.5 rounded-full transition-all duration-500 ${p || j < i ? "w-6 bg-[#6c0ef2]" : j === i ? "w-10 bg-[#6c0ef2]" : "w-6 bg-black/10"}`,
                    },
                    y.key,
                  ),
                ),
              }),
              p && (plan || planError)
                ? planError
                  ? jsxRuntime.jsxs("div", {
                      "code-path": "src\\components\\GeneratingPlan.tsx:175:13",
                      className: "gen-card-in mt-10 flex flex-col items-center",
                      children: [
                        jsxRuntime.jsx(ProductLogo, {
                          "code-path": "src\\components\\GeneratingPlan.tsx:176:15",
                          className: "h-20 w-20",
                        }),
                        jsxRuntime.jsx("h2", {
                          "code-path": "src\\components\\GeneratingPlan.tsx:177:15",
                          className:
                            "mt-6 text-2xl font-black tracking-tight text-[#111318] md:text-3xl",
                          children: "学习计划生成失败",
                        }),
                        jsxRuntime.jsx("p", {
                          "code-path": "src\\components\\GeneratingPlan.tsx:180:15",
                          className:
                            "mt-2 max-w-md text-sm font-semibold leading-relaxed text-[#8a8e9c]",
                          children: planError,
                        }),
                        jsxRuntime.jsxs("div", {
                          "code-path": "src\\components\\GeneratingPlan.tsx:182:15",
                          className: "mt-8 flex flex-wrap items-center justify-center gap-3",
                          children: [
                            jsxRuntime.jsx("button", {
                              "code-path": "src\\components\\GeneratingPlan.tsx:183:17",
                              onClick: () => setAttempt((value) => value + 1),
                              className:
                                "rounded-full bg-[#6c0ef2] px-8 py-3.5 text-base font-extrabold text-white shadow-[0_8px_24px_rgba(108,14,242,0.35)] transition-all hover:-translate-y-1 hover:bg-[#5a0bd2]",
                              children: "重新生成",
                            }),
                            jsxRuntime.jsx("button", {
                              "code-path": "src\\components\\GeneratingPlan.tsx:184:17",
                              onClick: u,
                              className:
                                "rounded-full border border-black/10 bg-white px-8 py-3.5 text-base font-extrabold text-[#111318] transition-colors hover:bg-black/5",
                              children: "先进入系统",
                            }),
                          ],
                        }),
                      ],
                    })
                  : jsxRuntime.jsxs("div", {
                    "code-path": "src\\components\\GeneratingPlan.tsx:175:13",
                    className: "gen-card-in mt-10 flex flex-col items-center",
                    children: [
                      jsxRuntime.jsx(ProductLogo, {
                        "code-path":
                          "src\\components\\GeneratingPlan.tsx:176:15",
                        className: "h-20 w-20",
                        animated: !0,
                      }),
                      jsxRuntime.jsx("h2", {
                        "code-path":
                          "src\\components\\GeneratingPlan.tsx:177:15",
                        className:
                          "mt-6 text-2xl font-black tracking-tight text-[#111318] md:text-3xl",
                        children: "学习计划已生成！",
                      }),
                      jsxRuntime.jsx("p", {
                        "code-path":
                          "src\\components\\GeneratingPlan.tsx:180:15",
                        className:
                          "mt-2 max-w-md text-sm font-semibold leading-relaxed text-[#8a8e9c]",
                        children: `已为你规划 ${plan?.stages?.length || 0} 个阶段、${plan?.horizonWeeks || 0} 周安排，每周约 ${plan?.weeklyHours || 0} 小时；学习画像与计划已保存到“我的画像”。`,
                      }),
                      jsxRuntime.jsx("div", {
                        "code-path":
                          "src\\components\\GeneratingPlan.tsx:182:15",
                        className:
                          "mt-5 flex max-w-md flex-wrap items-center justify-center gap-2",
                        children: (plan?.focusAreas || [])
                          .slice(0, 5)
                          .map((item) =>
                            jsxRuntime.jsx(
                              "span",
                              {
                                className:
                                  "rounded-lg bg-[#f4effe] px-3 py-1 text-xs font-bold text-[#6c0ef2]",
                                children: item,
                              },
                              item,
                            ),
                          ),
                      }),
                      jsxRuntime.jsx("button", {
                        "code-path":
                          "src\\components\\GeneratingPlan.tsx:184:15",
                        onClick: u,
                        className:
                          "mt-8 rounded-full bg-[#6c0ef2] px-10 py-4 text-lg font-extrabold text-white shadow-[0_8px_24px_rgba(108,14,242,0.4)] transition-all hover:-translate-y-1 hover:bg-[#5a0bd2]",
                        children: "查看我的学习计划",
                      }),
                    ],
                  })
                : jsxRuntime.jsxs(
                    "div",
                    {
                      "code-path": "src\\components\\GeneratingPlan.tsx:165:13",
                      className: "gen-card-in mt-10 flex flex-col items-center",
                      children: [
                        b.art === "profile" &&
                          jsxRuntime.jsx(Ib, {
                            "code-path":
                              "src\\components\\GeneratingPlan.tsx:166:43",
                            chips: x,
                          }),
                        b.art === "path" &&
                          jsxRuntime.jsx(e2, {
                            "code-path":
                              "src\\components\\GeneratingPlan.tsx:167:40",
                            subjects: h,
                          }),
                        b.art === "content" &&
                          jsxRuntime.jsx(t2, {
                            "code-path":
                              "src\\components\\GeneratingPlan.tsx:168:43",
                          }),
                        jsxRuntime.jsx("h2", {
                          "code-path":
                            "src\\components\\GeneratingPlan.tsx:169:15",
                          className:
                            "mt-8 text-2xl font-black tracking-tight text-[#111318] md:text-3xl",
                          children: b.title,
                        }),
                        jsxRuntime.jsx("p", {
                          "code-path":
                            "src\\components\\GeneratingPlan.tsx:172:15",
                          className:
                            "mt-2 text-sm font-semibold text-[#8a8e9c]",
                          children: b.subtitle,
                        }),
                      ],
                    },
                    b.key,
                  ),
            ],
          }),
          !(p && (plan || planError)) &&
            jsxRuntime.jsxs("p", {
              "code-path": "src\\components\\GeneratingPlan.tsx:195:11",
              className:
                "mt-6 flex items-center gap-2 text-sm font-semibold text-[#a78bfa]",
              children: [
                jsxRuntime.jsx("span", {
                  "code-path": "src\\components\\GeneratingPlan.tsx:196:13",
                  className: "gen-bar",
                  children: "✨",
                }),
                " AI 智能体工作中…",
              ],
            }),
        ],
      }),
    ],
  });
}

const sn = [
  {
    key: "role",
    title: "你目前是？",
    subtitle: "我们会为你推荐最合适的内容。",
    layout: "rows",
    options: [
      {
        value: "undergrad",
        label: "大学生",
        emoji: "🎓",
        feedback: "打好基础，未来可期！",
      },
      {
        value: "grad",
        label: "研究生",
        emoji: "📚",
        feedback: "深入钻研，更进一步。",
      },
      {
        value: "worker",
        label: "工作者",
        emoji: "💼",
        feedback: "职场进阶，稳步提升。",
      },
      {
        value: "other",
        label: "其他",
        emoji: "✨",
        feedback: "无论在哪，学习都不晚。",
      },
    ],
  },
  {
    key: "goal",
    title: "你最主要的学习目标是？",
    subtitle: "这会帮助我们为你定制学习体验。",
    layout: "grid",
    options: [
      {
        value: "job",
        label: "求职就业",
        emoji: "💼",
        feedback: "目标明确，冲刺理想 offer！",
      },
      {
        value: "exam",
        label: "考研升学",
        emoji: "🎓",
        feedback: "408 路上，我们陪你到底。",
      },
      {
        value: "project",
        label: "项目开发",
        emoji: "🛠️",
        feedback: "动手实战，做出自己的作品。",
      },
      {
        value: "skill",
        label: "技能提升",
        emoji: "🚀",
        feedback: "持续精进，保持竞争力。",
      },
    ],
  },
  {
    key: "subjects",
    title: "你想学习哪些科目？",
    subtitle: "至少选择 1 门，可以多选。",
    layout: "chips",
    multi: !0,
    options: [
      { value: "ds", label: "数据结构" },
      { value: "co", label: "计算机组成原理" },
      { value: "os", label: "操作系统" },
      { value: "cn", label: "计算机网络" },
      { value: "agent", label: "智能体" },
    ],
  },
  {
    key: "tech",
    title: "以下技术你接触过哪些？",
    subtitle: "如实选择即可，我们会校准学习起点。",
    layout: "chips",
    multi: !0,
    noneOption: "none",
    options: [
      { value: "cpp", label: "C/C++" },
      { value: "python", label: "Python" },
      { value: "java", label: "Java" },
      { value: "js", label: "JavaScript" },
      { value: "linux", label: "Linux" },
      { value: "mysql", label: "MySQL" },
      { value: "git", label: "Git" },
      { value: "other", label: "其他" },
      { value: "none", label: "都没有" },
    ],
  },
  {
    key: "deadline",
    title: "你希望在多长时间内达到目标？",
    subtitle: "我们会据此安排学习节奏。",
    layout: "rows",
    options: [
      {
        value: "1m",
        label: "1 个月",
        emoji: "⚡",
        feedback: "冲刺模式，火力全开！",
      },
      {
        value: "3m",
        label: "3 个月",
        emoji: "🌱",
        feedback: "短期突破，效率优先。",
      },
      {
        value: "6m",
        label: "6 个月",
        emoji: "🌿",
        feedback: "稳步进阶，循序渐进。",
      },
      {
        value: "1y",
        label: "1 年及以上",
        emoji: "🌳",
        feedback: "长期主义，系统成长。",
      },
    ],
  },
  {
    key: "daily",
    title: "你每天计划投入多少时间？",
    subtitle: "选择你的承诺，我们匹配节奏。",
    layout: "rows",
    options: [
      {
        value: "15min",
        label: "15 分钟",
        emoji: "⏱️",
        feedback: "碎片时间，也能积少成多。",
      },
      {
        value: "30min",
        label: "30 分钟",
        emoji: "🌱",
        feedback: "每天一点点，进步看得见。",
      },
      {
        value: "1h",
        label: "1 小时",
        emoji: "🌻",
        feedback: "认真的你，闪闪发光！",
      },
      {
        value: "2h+",
        label: "2 小时以上",
        emoji: "🌳",
        feedback: "全力以赴，未来可期！",
      },
    ],
  },
];

function normalizeOnboardingQuestions(configured) {
  if (!Array.isArray(configured) || configured.length === 0) return sn;
  const normalized = configured.map((question, index) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    const type = question?.type === "multi" ? "multi" : "single";
    const hasEmoji = options.some((option) => option?.emoji);
    return {
      key: String(question?.id || `question-${index + 1}`),
      title: String(question?.title || `问题 ${index + 1}`),
      subtitle: String(question?.subtitle || ""),
      required: question?.required !== false,
      multi: type === "multi",
      noneOption: options.some((option) => option?.value === "none") ? "none" : undefined,
      layout: type === "multi" ? "chips" : hasEmoji ? "rows" : "grid",
      options: options.map((option, optionIndex) => ({
        value: String(option?.value || `option-${optionIndex + 1}`),
        label: String(option?.label || `选项 ${optionIndex + 1}`),
        emoji: option?.emoji ? String(option.emoji) : "",
        feedback: option?.feedback ? String(option.feedback) : "",
      })),
    };
  }).filter((question) => question.options.length > 0);
  return normalized.length > 0 ? normalized : sn;
}

function OnboardingWizard({ onClose: n, onFinish: r }) {
  const brand = useOrgBrand();
  const questions = React.useMemo(() => normalizeOnboardingQuestions(brand?.onboardingQuestions), [brand?.onboardingQuestions]);
  const [u, i] = React.useState(0),
    [d, p] = React.useState({}),
    [m, b] = React.useState(!1),
    [h, x] = React.useState(!1),
    y = questions[u],
    j = d[y?.key ?? ""] ?? [],
    z = React.useMemo(() => (m ? !0 : y?.required === false || j.length >= 1), [j, m, y?.required]),
    R = (H) => {
      if (!y.multi) {
        p(($) => ({ ...$, [y.key]: [H] }));
        return;
      }
      p(($) => {
        const O = $[y.key] ?? [];
        if (y.noneOption) {
          if (H === y.noneOption) return { ...$, [y.key]: [H] };
          const P = O.filter((G) => G !== y.noneOption);
          return {
            ...$,
            [y.key]: P.includes(H) ? P.filter((G) => G !== H) : [...P, H],
          };
        }
        return {
          ...$,
          [y.key]: O.includes(H) ? O.filter((P) => P !== H) : [...O, H],
        };
      });
    },
    N = () => {
      z && (u < questions.length - 1 ? i((H) => H + 1) : b(!0));
    },
    E = () => {
      if (m) {
        b(!1);
        return;
      }
      u > 0 ? i((H) => H - 1) : n();
    };
  (React.useEffect(() => {
    const H = ($) => {
      ($.key === "Enter" && z && !m && N(), $.key === "Escape" && n());
    };
    return (
      window.addEventListener("keydown", H),
      () => window.removeEventListener("keydown", H)
    );
  }),
    React.useEffect(
      () => (
        (document.body.style.overflow = "hidden"),
        () => {
          document.body.style.overflow = "";
        }
      ),
      [],
    ));
  const _ = m ? 1 : (u + (z ? 1 : 0)) / questions.length,
    M = React.useMemo(
      () =>
        !y || y.multi || j.length === 0
          ? null
          : (y.options.find((H) => H.value === j[0])?.feedback ?? null),
      [y, j],
    ),
    B = React.useMemo(
      () =>
        questions.map((H) => ({
          key: H.key,
          title: H.title,
          items: (d[H.key] ?? [])
            .map(($) => H.options.find((O) => O.value === $)?.label)
            .filter(Boolean),
        })),
      [d, questions],
    ),
    Q = React.useMemo(
      () => Object.fromEntries(questions.map((H, $) => [H.key, B[$]])),
      [B],
    );
  if (h) {
    const H = {
      roleLabel: Q.role?.items[0] ?? "",
      goalLabel: Q.goal?.items[0] ?? "",
      subjectValues: d.subjects ?? [],
      onboardingAnswers: Q,
    };
    return jsxRuntime.jsx(GeneratingPlan, {
      "code-path": "src\\components\\OnboardingWizard.tsx:210:7",
      answers: Q,
      onClose: n,
      onComplete: () => (r ? r(H) : n()),
    });
  }
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\components\\OnboardingWizard.tsx:219:5",
    className: "fixed inset-0 z-[100] flex flex-col bg-white",
    children: [
      jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\OnboardingWizard.tsx:221:7",
        className: "mx-auto flex w-full max-w-5xl items-center gap-6 px-6 pt-6",
        children: [
          jsxRuntime.jsx("button", {
            "code-path": "src\\components\\OnboardingWizard.tsx:222:9",
            onClick: E,
            className:
              "flex h-9 w-9 items-center justify-center rounded-full text-xl text-[#111318] transition-colors hover:bg-black/5",
            "aria-label": "返回",
            children: "←",
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\OnboardingWizard.tsx:229:9",
            className: "h-2.5 flex-1 overflow-hidden rounded-full bg-[#eef0f4]",
            children: jsxRuntime.jsx("div", {
              "code-path": "src\\components\\OnboardingWizard.tsx:230:11",
              className:
                "h-full rounded-full bg-[#6c0ef2] transition-all duration-500 ease-out",
              style: { width: `${Math.max(_ * 100, 4)}%` },
            }),
          }),
          jsxRuntime.jsx(ProductLogo, {
            "code-path": "src\\components\\OnboardingWizard.tsx:235:9",
            className: "h-7 w-7",
          }),
        ],
      }),
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\OnboardingWizard.tsx:239:7",
        className:
          "flex flex-1 items-start justify-center overflow-y-auto px-6 pt-[8vh] md:pt-[12vh]",
        children: m
          ? jsxRuntime.jsxs("div", {
              "code-path": "src\\components\\OnboardingWizard.tsx:301:11",
              className: "anim-rise-in w-full max-w-2xl text-center",
              children: [
                jsxRuntime.jsx(ProductLogo, {
                  "code-path": "src\\components\\OnboardingWizard.tsx:302:13",
                  className: "mx-auto h-20 w-20",
                  animated: !0,
                }),
                jsxRuntime.jsx("h2", {
                  "code-path": "src\\components\\OnboardingWizard.tsx:303:13",
                  className:
                    "mt-6 text-3xl font-black tracking-tight text-[#111318] md:text-4xl",
                  children: "问卷完成！",
                }),
                jsxRuntime.jsx("p", {
                  "code-path": "src\\components\\OnboardingWizard.tsx:306:13",
                  className: "mt-3 text-base font-semibold text-[#8a8e9c]",
                  children:
                    "这是你的学习画像，智能体将据此生成个性化学习计划。",
                }),
                jsxRuntime.jsx("div", {
                  "code-path": "src\\components\\OnboardingWizard.tsx:310:13",
                  className:
                    "mx-auto mt-8 flex max-w-xl flex-col gap-3 text-left",
                  children: B.map(
                    (H) =>
                      H.items.length > 0 &&
                      jsxRuntime.jsxs(
                        "div",
                        {
                          "code-path":
                            "src\\components\\OnboardingWizard.tsx:314:21",
                          className:
                            "flex flex-wrap items-center gap-2 rounded-2xl border border-black/10 px-5 py-3",
                          children: [
                            jsxRuntime.jsx("span", {
                              "code-path":
                                "src\\components\\OnboardingWizard.tsx:318:23",
                              className:
                                "mr-2 text-sm font-extrabold text-[#111318]",
                              children: H.title.replace(/[？?]$/, ""),
                            }),
                            H.items.map(($) =>
                              jsxRuntime.jsx(
                                "span",
                                {
                                  "code-path":
                                    "src\\components\\OnboardingWizard.tsx:322:25",
                                  className:
                                    "rounded-lg bg-[#f4effe] px-3 py-1 text-xs font-bold text-[#6c0ef2]",
                                  children: $,
                                },
                                $,
                              ),
                            ),
                          ],
                        },
                        H.title,
                      ),
                  ),
                }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\components\\OnboardingWizard.tsx:334:13",
                  onClick: () => x(!0),
                  className:
                    "mt-10 rounded-full bg-[#6c0ef2] px-10 py-4 text-lg font-extrabold text-white shadow-[0_8px_24px_rgba(108,14,242,0.4)] transition-all hover:-translate-y-1 hover:bg-[#5a0bd2]",
                  children: "生成我的学习计划",
                }),
              ],
            })
          : jsxRuntime.jsxs(
              "div",
              {
                "code-path": "src\\components\\OnboardingWizard.tsx:241:11",
                className: "anim-rise-in w-full max-w-2xl text-center",
                children: [
                  jsxRuntime.jsx("h2", {
                    "code-path": "src\\components\\OnboardingWizard.tsx:242:13",
                    className:
                      "text-3xl font-black tracking-tight text-[#111318] md:text-4xl",
                    children: y.title,
                  }),
                  jsxRuntime.jsx("p", {
                    "code-path": "src\\components\\OnboardingWizard.tsx:245:13",
                    className: "mt-3 text-base font-semibold text-[#8a8e9c]",
                    children: y.subtitle,
                  }),
                  jsxRuntime.jsx("div", {
                    "code-path": "src\\components\\OnboardingWizard.tsx:248:13",
                    className:
                      y.layout === "grid"
                        ? "mx-auto mt-10 grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2"
                        : y.layout === "rows"
                          ? "mx-auto mt-10 flex max-w-xl flex-col gap-4"
                          : "mx-auto mt-10 flex max-w-xl flex-wrap justify-center gap-3",
                    children: y.options.map((H) => {
                      const $ = j.includes(H.value);
                      return y.layout === "chips"
                        ? jsxRuntime.jsx(
                            "button",
                            {
                              "code-path":
                                "src\\components\\OnboardingWizard.tsx:261:21",
                              onClick: () => R(H.value),
                              className: `rounded-xl border px-5 py-2.5 text-sm font-bold transition-all ${$ ? "border-[#6c0ef2] bg-[#f4effe] text-[#6c0ef2] shadow-sm" : "border-black/10 bg-white text-[#111318] hover:border-[#6c0ef2]/50"}`,
                              children: H.label,
                            },
                            H.value,
                          )
                        : jsxRuntime.jsxs(
                            "button",
                            {
                              "code-path":
                                "src\\components\\OnboardingWizard.tsx:275:19",
                              onClick: () => R(H.value),
                              className: `flex items-center gap-4 rounded-2xl border px-6 py-4 text-left text-base font-bold transition-all ${$ ? "border-[#6c0ef2] bg-[#f4effe] shadow-[0_2px_12px_rgba(108,14,242,0.12)]" : "border-black/10 bg-white hover:border-[#6c0ef2]/50"}`,
                              children: [
                                H.emoji &&
                                  jsxRuntime.jsx("span", {
                                    "code-path":
                                      "src\\components\\OnboardingWizard.tsx:284:35",
                                    className: "text-2xl",
                                    children: H.emoji,
                                  }),
                                jsxRuntime.jsx("span", {
                                  "code-path":
                                    "src\\components\\OnboardingWizard.tsx:285:21",
                                  className: $
                                    ? "text-[#6c0ef2]"
                                    : "text-[#111318]",
                                  children: H.label,
                                }),
                              ],
                            },
                            H.value,
                          );
                    }),
                  }),
                  M &&
                    jsxRuntime.jsxs("div", {
                      "code-path":
                        "src\\components\\OnboardingWizard.tsx:293:15",
                      className: "mt-10",
                      children: [
                        jsxRuntime.jsx("div", {
                          "code-path":
                            "src\\components\\OnboardingWizard.tsx:294:17",
                          className: "mx-auto mb-4 h-px w-8 bg-black/15",
                        }),
                        jsxRuntime.jsx("p", {
                          "code-path":
                            "src\\components\\OnboardingWizard.tsx:295:17",
                          className: "text-sm font-semibold text-[#8a8e9c]",
                          children: M,
                        }),
                      ],
                    }),
                ],
              },
              y.key,
            ),
      }),
      !m &&
        jsxRuntime.jsx("div", {
          "code-path": "src\\components\\OnboardingWizard.tsx:346:9",
          className: "border-t border-black/5",
          children: jsxRuntime.jsx("div", {
            "code-path": "src\\components\\OnboardingWizard.tsx:347:11",
            className:
              "mx-auto flex w-full max-w-5xl items-center justify-end px-6 py-5",
            children: jsxRuntime.jsxs("div", {
              "code-path": "src\\components\\OnboardingWizard.tsx:348:13",
              className: "flex items-center gap-4",
              children: [
                z &&
                  jsxRuntime.jsx("span", {
                    "code-path": "src\\components\\OnboardingWizard.tsx:349:27",
                    className: "text-sm font-semibold text-[#b6bac6]",
                    children: "或按 Enter",
                  }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\components\\OnboardingWizard.tsx:350:15",
                  onClick: N,
                  disabled: !z,
                  className: `rounded-full px-8 py-3 text-sm font-extrabold transition-all ${z ? "bg-[#6c0ef2] text-white shadow-[0_4px_14px_rgba(108,14,242,0.35)] hover:-translate-y-0.5 hover:bg-[#5a0bd2]" : "cursor-not-allowed bg-[#eef0f4] text-[#b6bac6]"}`,
                  children: u === questions.length - 1 ? "完成" : "继续",
                }),
              ],
            }),
          }),
        }),
    ],
  });
}

const n2 = (n) => n.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
  s2 = (n) =>
    n.replace(/^([A-Z])|[\s-_]+(\w)/g, (r, u, i) =>
      i ? i.toUpperCase() : u.toLowerCase(),
    ),
  Uh = (n) => {
    const r = s2(n);
    return r.charAt(0).toUpperCase() + r.slice(1);
  },
  Cm = (...n) =>
    n
      .filter((r, u, i) => !!r && r.trim() !== "" && i.indexOf(r) === u)
      .join(" ")
      .trim(),
  o2 = (n) => {
    for (const r in n)
      if (r.startsWith("aria-") || r === "role" || r === "title") return !0;
  };

var c2 = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const r2 = React.forwardRef(
  (
    {
      color: n = "currentColor",
      size: r = 24,
      strokeWidth: u = 2,
      absoluteStrokeWidth: i,
      className: d = "",
      children: p,
      iconNode: m,
      ...b
    },
    h,
  ) =>
    React.createElement(
      "svg",
      {
        ref: h,
        ...c2,
        width: r,
        height: r,
        stroke: n,
        strokeWidth: i ? (Number(u) * 24) / Number(r) : u,
        className: Cm("lucide", d),
        ...(!p && !o2(b) && { "aria-hidden": "true" }),
        ...b,
      },
      [
        ...m.map(([x, y]) => React.createElement(x, y)),
        ...(Array.isArray(p) ? p : [p]),
      ],
    ),
);

const ie = (n, r) => {
  const u = React.forwardRef(({ className: i, ...d }, p) =>
    React.createElement(r2, {
      ref: p,
      iconNode: r,
      className: Cm(`lucide-${n2(Uh(n))}`, `lucide-${n}`, i),
      ...d,
    }),
  );
  return ((u.displayName = Uh(n)), u);
};

const i2 = [
    ["path", { d: "m12 19-7-7 7-7", key: "1l729n" }],
    ["path", { d: "M19 12H5", key: "x3x0zl" }],
  ],
  lu = ie("arrow-left", i2);

const u2 = [
    ["path", { d: "M12 7v14", key: "1akyts" }],
    [
      "path",
      {
        d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        key: "ruj8y",
      },
    ],
  ],
  $a = ie("book-open", u2);

const d2 = [
    [
      "path",
      {
        d: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z",
        key: "1fy3hk",
      },
    ],
  ],
  bn = ie("bookmark", d2);

const f2 = [
    ["path", { d: "M12 8V4H8", key: "hb8ula" }],
    [
      "rect",
      { width: "16", height: "12", x: "4", y: "8", rx: "2", key: "enze0r" },
    ],
    ["path", { d: "M2 14h2", key: "vft8re" }],
    ["path", { d: "M20 14h2", key: "4cs60a" }],
    ["path", { d: "M15 13v2", key: "1xurst" }],
    ["path", { d: "M9 13v2", key: "rq6x2g" }],
  ],
  fn = ie("bot", f2);

const p2 = [
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    [
      "rect",
      { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" },
    ],
    ["path", { d: "M3 10h18", key: "8toen8" }],
    ["path", { d: "M8 14h.01", key: "6423bh" }],
    ["path", { d: "M12 14h.01", key: "1etili" }],
    ["path", { d: "M16 14h.01", key: "1gbofw" }],
    ["path", { d: "M8 18h.01", key: "lrp35t" }],
    ["path", { d: "M12 18h.01", key: "mhygvu" }],
    ["path", { d: "M16 18h.01", key: "kzsmim" }],
  ],
  _m = ie("calendar-days", p2);

const h2 = [
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    [
      "rect",
      { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" },
    ],
    ["path", { d: "M3 10h18", key: "8toen8" }],
  ],
  m2 = ie("calendar", h2);

const x2 = [
    [
      "path",
      {
        d: "M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z",
        key: "18u6gg",
      },
    ],
    ["circle", { cx: "12", cy: "13", r: "3", key: "1vg3eu" }],
  ],
  vs = ie("camera", x2);

const g2 = [
    ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16", key: "c24i48" }],
    ["path", { d: "M18 17V9", key: "2bz60n" }],
    ["path", { d: "M13 17V5", key: "1frdt8" }],
    ["path", { d: "M8 17v-3", key: "17ska0" }],
  ],
  nu = ie("chart-column", g2);

const b2 = [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]],
  Dm = ie("check", b2);

const y2 = [["path", { d: "m15 18-6-6 6-6", key: "1wnfg3" }]],
  Mm = ie("chevron-left", y2);

const v2 = [["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]],
  Am = ie("chevron-right", v2);

const j2 = [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }],
  ],
  pn = ie("circle-check", j2);

const w2 = [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "m15 9-6 6", key: "1uzhvr" }],
    ["path", { d: "m9 9 6 6", key: "z0biqf" }],
  ],
  Bh = ie("circle-x", w2);

const N2 = [["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]],
  S2 = ie("circle", N2);

const k2 = [
    [
      "rect",
      {
        width: "8",
        height: "4",
        x: "8",
        y: "2",
        rx: "1",
        ry: "1",
        key: "tgr4d6",
      },
    ],
    [
      "path",
      {
        d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
        key: "116196",
      },
    ],
    ["path", { d: "m9 14 2 2 4-4", key: "df797q" }],
  ],
  z2 = ie("clipboard-check", k2);

const E2 = [
    ["path", { d: "M12 6v6h4", key: "135r8i" }],
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ],
  yl = ie("clock-3", E2);

const C2 = [
    ["path", { d: "M12 6v6l4 2", key: "mmk7yg" }],
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ],
  Tm = ie("clock", C2);

const _2 = [
    [
      "path",
      {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
        key: "1oefj6",
      },
    ],
    ["path", { d: "M12 17h.01", key: "p32p05" }],
    ["path", { d: "M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3", key: "mhlwft" }],
  ],
  D2 = ie("file-question-mark", _2);

const M2 = [
    [
      "path",
      {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
        key: "1oefj6",
      },
    ],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "M8 12h8", key: "1wcyev" }],
    ["path", { d: "M10 11v2", key: "1s651w" }],
    ["path", { d: "M8 17h8", key: "wh5c61" }],
    ["path", { d: "M14 16v2", key: "12fp5e" }],
  ],
  A2 = ie("file-sliders", M2);

const T2 = [
    [
      "path",
      {
        d: "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4",
        key: "1slcih",
      },
    ],
  ],
  Rm = ie("flame", T2);

const R2 = [
    [
      "path",
      {
        d: "M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z",
        key: "j76jl0",
      },
    ],
    ["path", { d: "M22 10v6", key: "1lu8f3" }],
    ["path", { d: "M6 12.5V16a6 3 0 0 0 12 0v-3.5", key: "1r8lef" }],
  ],
  Lm = ie("graduation-cap", R2);

const L2 = [
    ["circle", { cx: "9", cy: "12", r: "1", key: "1vctgf" }],
    ["circle", { cx: "9", cy: "5", r: "1", key: "hp0tcf" }],
    ["circle", { cx: "9", cy: "19", r: "1", key: "fkjjf6" }],
    ["circle", { cx: "15", cy: "12", r: "1", key: "1tmaij" }],
    ["circle", { cx: "15", cy: "5", r: "1", key: "19l28e" }],
    ["circle", { cx: "15", cy: "19", r: "1", key: "f4zoj3" }],
  ],
  O2 = ie("grip-vertical", L2);

const U2 = [
    [
      "path",
      { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8", key: "5wwlr5" },
    ],
    [
      "path",
      {
        d: "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
        key: "r6nss1",
      },
    ],
  ],
  B2 = ie("house", U2);

const H2 = [
    ["path", { d: "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7", key: "132q7q" }],
    [
      "rect",
      { x: "2", y: "4", width: "20", height: "16", rx: "2", key: "izxlao" },
    ],
  ],
  G2 = ie("mail", H2);

const q2 = [
    [
      "path",
      {
        d: "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
        key: "1r0f0z",
      },
    ],
    ["circle", { cx: "12", cy: "10", r: "3", key: "ilqhr7" }],
  ],
  Q2 = ie("map-pin", q2);

const Y2 = [
    ["path", { d: "M15 3h6v6", key: "1q9fwt" }],
    ["path", { d: "m21 3-7 7", key: "1l2asr" }],
    ["path", { d: "m3 21 7-7", key: "tjx5ai" }],
    ["path", { d: "M9 21H3v-6", key: "wtvkvv" }],
  ],
  V2 = ie("maximize-2", Y2);

const X2 = [
    [
      "path",
      {
        d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
        key: "1sd12s",
      },
    ],
  ],
  cc = ie("message-circle", X2);

const Z2 = [
    ["path", { d: "M12 19v3", key: "npa21l" }],
    ["path", { d: "M15 9.34V5a3 3 0 0 0-5.68-1.33", key: "1gzdoj" }],
    ["path", { d: "M16.95 16.95A7 7 0 0 1 5 12v-2", key: "cqa7eg" }],
    ["path", { d: "M18.89 13.23A7 7 0 0 0 19 12v-2", key: "16hl24" }],
    ["path", { d: "m2 2 20 20", key: "1ooewy" }],
    ["path", { d: "M9 9v3a3 3 0 0 0 5.12 2.12", key: "r2i35w" }],
  ],
  su = ie("mic-off", Z2);

const K2 = [
    ["path", { d: "M12 19v3", key: "npa21l" }],
    ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2", key: "1vc78b" }],
    [
      "rect",
      { x: "9", y: "2", width: "6", height: "13", rx: "3", key: "s6n7sd" },
    ],
  ],
  ou = ie("mic", K2);

const $2 = [
    ["path", { d: "m14 10 7-7", key: "oa77jy" }],
    ["path", { d: "M20 10h-6V4", key: "mjg0md" }],
    ["path", { d: "m3 21 7-7", key: "tjx5ai" }],
    ["path", { d: "M4 14h6v6", key: "rmj7iw" }],
  ],
  J2 = ie("minimize-2", $2);

const P2 = [["path", { d: "M5 12h14", key: "1ays0h" }]],
  W2 = ie("minus", P2);

const F2 = [
    [
      "rect",
      { x: "14", y: "3", width: "5", height: "18", rx: "1", key: "kaeet6" },
    ],
    [
      "rect",
      { x: "5", y: "3", width: "5", height: "18", rx: "1", key: "1wsw3u" },
    ],
  ],
  I2 = ie("pause", F2);

const ey = [
    [
      "path",
      {
        d: "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384",
        key: "9njp5v",
      },
    ],
  ],
  ty = ie("phone", ey);

const ay = [
    [
      "path",
      {
        d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",
        key: "10ikf1",
      },
    ],
  ],
  Om = ie("play", ay);

const ly = [
    ["path", { d: "M5 12h14", key: "1ays0h" }],
    ["path", { d: "M12 5v14", key: "s699le" }],
  ],
  rc = ie("plus", ly);

const ny = [
    [
      "path",
      { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "1357e3" },
    ],
    ["path", { d: "M3 3v5h5", key: "1xhq8a" }],
  ],
  sy = ie("rotate-ccw", ny);

const oy = [
    ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
    ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ],
  Vi = ie("search", oy);

const cy = [
    [
      "path",
      {
        d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        key: "1ffxy3",
      },
    ],
    ["path", { d: "m21.854 2.147-10.94 10.939", key: "12cjpa" }],
  ],
  ic = ie("send", cy);

const ry = [
    ["circle", { cx: "18", cy: "5", r: "3", key: "gq8acd" }],
    ["circle", { cx: "6", cy: "12", r: "3", key: "w7nqdw" }],
    ["circle", { cx: "18", cy: "19", r: "3", key: "1xt0gg" }],
    [
      "line",
      { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49", key: "47mynk" },
    ],
    [
      "line",
      { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49", key: "1n3mei" },
    ],
  ],
  iy = ie("share-2", ry);

const uy = [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        key: "oel41y",
      },
    ],
    ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }],
  ],
  dy = ie("shield-check", uy);

const fy = [
    [
      "path",
      {
        d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
        key: "1s2grr",
      },
    ],
    ["path", { d: "M20 2v4", key: "1rf3ol" }],
    ["path", { d: "M22 4h-4", key: "gwowj6" }],
    ["circle", { cx: "4", cy: "20", r: "2", key: "6kqj1y" }],
  ],
  hn = ie("sparkles", fy);

const py = [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["circle", { cx: "12", cy: "12", r: "6", key: "1vlfrh" }],
    ["circle", { cx: "12", cy: "12", r: "2", key: "1c9p78" }],
  ],
  Um = ie("target", py);

const hy = [
    ["path", { d: "M10 11v6", key: "nco0om" }],
    ["path", { d: "M14 11v6", key: "outv1u" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", key: "miytrc" }],
    ["path", { d: "M3 6h18", key: "d0wm0j" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", key: "e791ji" }],
  ],
  my = ie("trash-2", hy);

const xy = [
    ["path", { d: "M16 7h6v6", key: "box55l" }],
    ["path", { d: "m22 7-8.5 8.5-5-5L2 17", key: "1t1m79" }],
  ],
  gy = ie("trending-up", xy);

const by = [
    ["circle", { cx: "12", cy: "8", r: "5", key: "1hypcn" }],
    ["path", { d: "M20 21a8 8 0 0 0-16 0", key: "rfgkzh" }],
  ],
  yy = ie("user-round", by);

const vy = [
    ["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", key: "975kel" }],
    ["circle", { cx: "12", cy: "7", r: "4", key: "17ys0d" }],
  ],
  jy = ie("user", vy);

const wy = [
    [
      "path",
      {
        d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
        key: "ftymec",
      },
    ],
    [
      "rect",
      { x: "2", y: "6", width: "14", height: "12", rx: "2", key: "158x01" },
    ],
  ],
  Ny = ie("video", wy);

const Sy = [
    ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
    ["path", { d: "m6 6 12 12", key: "d8bk6v" }],
  ],
  uc = ie("x", Sy),
  ky = [
    { id: "home", icon: B2, label: "首页" },
    { id: "bookmarks", icon: bn, label: "收藏夹" },
    { id: "courses", icon: $a, label: "课程" },
    { id: "coach", icon: Lm, label: "Agent" },
    { id: "progress", icon: yy, label: "我的画像" },
  ];

function AccountMenu({ open, onEdit, onLogout }) {
  if (!open) return null;
  return jsxRuntime.jsxs("div", {
    role: "menu",
    className: "zx-account-menu",
    children: [
      jsxRuntime.jsx("button", {
        type: "button",
        role: "menuitem",
        className: "zx-account-menu-item",
        onClick: onEdit,
        children: "编辑资料",
      }),
      jsxRuntime.jsx("button", {
        type: "button",
        role: "menuitem",
        className: "zx-account-menu-item is-danger",
        onClick: onLogout,
        children: "退出登录",
      }),
    ],
  });
}

function AppNavigation({
  active: n,
  onNavigate: r,
  searchValue: u,
  onSearchChange: i,
}) {
  const learning = useLearning();
  const brand = useOrgBrand();
  const profile = learning.data?.profile;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef(null);
  const displayName = localStorage.getItem("zhixun-display-name") || "学习者";
  const avatarText = Array.from((profile?.name || displayName).trim())[0] || "学";
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  return jsxRuntime.jsx("header", {
    "code-path": "src\\components\\AppNavigation.tsx:35:5",
    className:
      "sticky top-0 z-50 border-b border-black/[0.07] bg-white/95 backdrop-blur-lg",
    children: jsxRuntime.jsxs("div", {
      "code-path": "src\\components\\AppNavigation.tsx:36:7",
      className:
        "zx-app-navigation-inner mx-auto flex h-[84px] max-w-[1680px] items-center justify-between gap-5 px-5 sm:px-8",
      children: [
        jsxRuntime.jsxs("div", {
          "code-path": "src\\components\\AppNavigation.tsx:37:9",
          className: "zx-app-navigation-brand flex shrink-0 items-center gap-2.5 text-left",
          children: [
            brand?.websiteUrl
              ? jsxRuntime.jsx("a", {
                  href: brand.websiteUrl,
                  target: "_blank",
                  rel: "noreferrer",
                  className: "zx-app-navigation-logo-link",
                  "aria-label": `打开${brand.name || brand.shortName || "机构"}官网`,
                  children: jsxRuntime.jsx(ProductLogo, {
                    "code-path": "src\\components\\AppNavigation.tsx:43:11",
                    className: "h-9 w-9 sm:h-10 sm:w-10",
                  }),
                })
              : jsxRuntime.jsx("button", {
                  type: "button",
                  onClick: () => r("home"),
                  className: "zx-app-navigation-logo-link",
                  "aria-label": "返回首页",
                  children: jsxRuntime.jsx(ProductLogo, {
                    "code-path": "src\\components\\AppNavigation.tsx:43:11",
                    className: "h-9 w-9 sm:h-10 sm:w-10",
                  }),
                }),
            jsxRuntime.jsx("span", {
              "code-path": "src\\components\\AppNavigation.tsx:44:11",
              className:
                "zx-app-navigation-system-name hidden text-xl font-black tracking-wide text-[#111318] sm:inline xl:text-2xl",
              children: "智训云枢",
            }),
            brand?.shortName && (brand.websiteUrl
              ? jsxRuntime.jsx("a", {
                  href: brand.websiteUrl,
                  target: "_blank",
                  rel: "noreferrer",
                  className: "zx-learner-org-badge",
                  title: `打开${brand.name || brand.shortName}官网`,
                  children: brand.shortName,
                })
              : jsxRuntime.jsx("span", {
                  className: "zx-learner-org-badge",
                  title: brand.shortName,
                  children: brand.shortName,
                })),
          ],
        }),
        jsxRuntime.jsx("nav", {
          "code-path": "src\\components\\AppNavigation.tsx:49:9",
          className: "zx-app-navigation-nav flex h-full items-center gap-0.5 sm:gap-1",
          "aria-label": "主导航",
          children: ky.map((d) => {
            const p = d.id === n;
            return jsxRuntime.jsxs(
              "button",
              {
                "code-path": "src\\components\\AppNavigation.tsx:53:15",
                type: "button",
                onClick: () => r(d.id),
                className: `group relative flex h-[66px] min-w-[52px] flex-col items-center justify-center gap-1 rounded-xl px-2 transition-all sm:min-w-[68px] sm:px-3 xl:min-w-[88px] ${p ? "bg-[#f7f4ff] text-[#6038ef] shadow-[inset_0_0_0_1px_rgba(96,56,239,0.12)]" : "text-[#535762] hover:bg-[#f8f8f9] hover:text-[#111318]"}`,
                "aria-current": p ? "page" : void 0,
                children: [
                  jsxRuntime.jsx(d.icon, {
                    "code-path": "src\\components\\AppNavigation.tsx:64:17",
                    className: "h-[22px] w-[22px] sm:h-6 sm:w-6",
                    strokeWidth: p ? 2.35 : 2.05,
                  }),
                  jsxRuntime.jsx("span", {
                    "code-path": "src\\components\\AppNavigation.tsx:70:17",
                    className: `hidden text-xs sm:block ${p ? "font-black" : "font-bold"}`,
                    children: d.label,
                  }),
                ],
              },
              d.id,
            );
          }),
        }),
        jsxRuntime.jsxs("div", {
          "code-path": "src\\components\\AppNavigation.tsx:78:9",
          className: "zx-app-navigation-actions flex shrink-0 items-center gap-3 sm:gap-5",
          children: [
            jsxRuntime.jsxs("label", {
              "code-path": "src\\components\\AppNavigation.tsx:79:11",
              className:
                "hidden h-11 items-center gap-2.5 rounded-xl border border-black/10 bg-white px-4 transition focus-within:border-[#6c0ef2]/40 focus-within:ring-4 focus-within:ring-[#6c0ef2]/5 lg:flex",
              children: [
                jsxRuntime.jsx(Vi, {
                  "code-path": "src\\components\\AppNavigation.tsx:80:13",
                  className: "h-5 w-5 text-[#747985]",
                }),
                jsxRuntime.jsx("input", {
                  "code-path": "src\\components\\AppNavigation.tsx:81:13",
                  value: u,
                  onChange: (d) => i?.(d.target.value),
                  placeholder: "搜索",
                  className:
                    "w-36 bg-transparent text-sm font-semibold text-[#111318] outline-none placeholder:text-[#8a8e9c] xl:w-44",
                  "aria-label": "搜索课程",
                }),
              ],
            }),
            jsxRuntime.jsxs("div", {
              ref: menuRef,
              className: "relative",
              children: [
              jsxRuntime.jsxs("button", {
              "code-path": "src\\components\\AppNavigation.tsx:89:11",
              type: "button",
              onClick: () => setMenuOpen((value) => !value),
              "aria-expanded": menuOpen,
              "aria-haspopup": "menu",
              className:
                "flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-[#D7DEE8] text-lg font-black text-white shadow-sm transition hover:ring-4 hover:ring-[#6038ef]/12 sm:h-12 sm:w-12",
              style: profile?.avatarBackground ? { backgroundColor: profile.avatarBackground } : undefined,
              title: "账号菜单",
              "aria-label": "账号菜单",
              children: profile?.avatar
                ? jsxRuntime.jsx("img", { src: profile.avatar, alt: "", className: "h-full w-full object-cover" })
                : avatarText,
              }),
              jsxRuntime.jsx(AccountMenu, {
                open: menuOpen,
                onEdit: () => { setMenuOpen(false); r("profile"); },
                onLogout: () => { clearLearningSession(); window.location.assign("/login"); },
              }),
            ]}),
          ],
        }),
      ],
    }),
  });
}

function zs({ onComplete: n }) {
  return (
    React.useEffect(() => {
      const r = window.setTimeout(n, 1800);
      return () => window.clearTimeout(r);
    }, [n]),
    jsxRuntime.jsx("div", {
      "code-path": "src\\components\\CourseLoader.tsx:14:5",
      className:
        "fixed inset-0 z-[100] grid min-h-screen place-items-center bg-[#f7f8fa]",
      children: jsxRuntime.jsxs("div", {
        "code-path": "src\\components\\CourseLoader.tsx:15:7",
        className:
          "route-loader grid justify-items-center gap-[22px] text-[#111318]",
        role: "status",
        "aria-label": "正在加载",
        children: [
          jsxRuntime.jsxs("svg", {
            "code-path": "src\\components\\CourseLoader.tsx:16:9",
            viewBox: "0 0 120 120",
            className: "h-[88px] w-[88px] overflow-visible",
            "aria-hidden": "true",
            children: [
              jsxRuntime.jsx("path", {
                "code-path": "src\\components\\CourseLoader.tsx:17:11",
                className: "route-loader-piece-a",
                d: "M18 35 38 15h27v18L48 50v20H18z",
              }),
              jsxRuntime.jsx("path", {
                "code-path": "src\\components\\CourseLoader.tsx:18:11",
                className: "route-loader-piece-b",
                d: "M55 50 72 33V15h30v35H82L65 67H55z",
              }),
              jsxRuntime.jsx("path", {
                "code-path": "src\\components\\CourseLoader.tsx:19:11",
                className: "route-loader-piece-c",
                d: "M38 77h17l17-17h30v25l-20 20H55V87H38z",
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\components\\CourseLoader.tsx:21:9",
            className: "text-[13px] tracking-[0.18em] opacity-[0.58]",
            children: "正在构建学习空间",
          }),
        ],
      }),
    })
  );
}

function ResourceOptionIcon({ type }) {
  const paths = {
    lecture: "M12 7v14m0-14C9 4 5 4 3 5v14c3-1 6-1 9 2m0-14c3-3 7-3 9-2v14c-3-1-6-1-9 2",
    slides: "M3 4h18v13H3zM12 17v4m-4 0h8M7 8h10m-10 4h6",
    bank: "m8 12 3 3 5-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[type]} /></svg>;
}

export function LessonStartModal({ course, lessonTitle, lessonIndex, onClose, onSelectResource }) {
  const dialogRef = React.useRef(null);
  const availableTypes = resourceTypes(course.chapters[lessonIndex]);
  const keepFocus = (event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll("button:not([disabled])") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  React.useEffect(() => {
    const overflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    const close = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", close);
      previousFocus?.focus();
    };
  }, [onClose]);
  return <div className="lesson-start-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
    <section ref={dialogRef} onKeyDown={keepFocus} className="lesson-start-dialog" role="dialog" aria-modal="true" aria-labelledby="lesson-start-title" aria-describedby="lesson-start-description">
      <button type="button" autoFocus onClick={onClose} className="lesson-start-close" aria-label="关闭课时弹窗">{jsxRuntime.jsx(uc, { className: "h-5 w-5" })}</button>
      <header className="lesson-start-header">
        <div className="lesson-start-artwork"><img src={course.icon} alt="" /></div>
        <p className="lesson-start-course" title={course.name}>{course.name}</p>
        <div className="lesson-start-caption">课时 {course.chapters[lessonIndex]?.orderNo ?? lessonIndex + 1}</div>
        <h2 id="lesson-start-title" title={lessonTitle}>{lessonTitle}</h2>
        <p id="lesson-start-description">选择一种方式，开始本章学习</p>
      </header>
      <div className="lesson-start-options">
        {RESOURCE_OPTIONS.map((choice) => {
          const available = availableTypes.includes(choice.type);
          return <button key={choice.type} type="button" disabled={!available} onClick={() => { if (available) onSelectResource(choice.mode); }} className={`lesson-start-option${available && availableTypes.length === 1 ? " lesson-start-option-primary" : ""}`}>
          <span className="lesson-start-option-icon"><ResourceOptionIcon type={choice.type} /></span>
          <span className="lesson-start-option-copy"><span className="lesson-start-option-label">{choice.label}</span><span className="lesson-start-option-detail">{choice.detail}</span></span>
          {available ? <svg className="lesson-start-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg> : <span className="lesson-start-unpublished">暂未发布</span>}
        </button>;
        })}
        {!availableTypes.length && <p className="lesson-start-empty">本章资源暂未发布，请稍后再来。</p>}
      </div>
    </section>
  </div>;
}

let $t = [
  {
    id: "ds",
    name: "数据结构",
    icon: "/courses/data-structures.png",
    description:
      "从线性表、树与图出发，理解数据组织方式，逐步掌握算法分析与问题建模。",
    level: "入门到进阶",
    duration: 12,
    chapters: [
      { title: "线性表与顺序存储", done: !0 },
      { title: "栈与队列", done: !0 },
      { title: "树的基本概念", done: !0 },
      { title: "树与图的遍历", done: !1 },
      { title: "图的最短路径", done: !1 },
    ],
  },
  {
    id: "co",
    name: "计算机组成原理",
    icon: "/courses/computer-organization.png",
    description:
      "理解处理器、存储器与输入输出系统，建立计算机硬件协同工作的整体认识。",
    level: "中等",
    duration: 14,
    chapters: [
      { title: "数据的机器级表示", done: !0 },
      { title: "运算方法与运算器", done: !0 },
      { title: "存储器层次结构", done: !1 },
      { title: "指令系统与 CPU", done: !1 },
      { title: "总线与输入输出", done: !1 },
    ],
  },
  {
    id: "os",
    name: "操作系统",
    icon: "/courses/operating-systems.png",
    description:
      "学习进程调度、内存管理与文件系统，理解操作系统如何协调和管理资源。",
    level: "中等",
    duration: 16,
    chapters: [
      { title: "操作系统概述", done: !0 },
      { title: "进程与线程", done: !0 },
      { title: "处理机调度与死锁", done: !0 },
      { title: "内存管理", done: !1 },
      { title: "文件系统与 IO", done: !1 },
    ],
  },
  {
    id: "cn",
    name: "计算机网络",
    icon: "/courses/computer-networks.png",
    description:
      "从分层模型到 TCP/IP 协议，理解数据如何在网络中可靠、高效地传输。",
    level: "中等",
    duration: 14,
    chapters: [
      { title: "体系结构与物理层", done: !0 },
      { title: "数据链路层", done: !0 },
      { title: "网络层与 IP", done: !1 },
      { title: "传输层 TCP/UDP", done: !1 },
      { title: "应用层协议", done: !1 },
    ],
  },
  {
    id: "agent",
    name: "智能体（Agent）",
    icon: "/courses/intelligent-agents.png",
    description:
      "认识智能体的感知、规划与协作机制，逐步掌握多智能体系统的核心方法。",
    level: "进阶",
    duration: 10,
    chapters: [
      { title: "智能体基础概念", done: !0 },
      { title: "提示工程与工具调用", done: !1 },
      { title: "规划与记忆机制", done: !1 },
      { title: "多智能体协同", done: !1 },
    ],
  },
];

function setCourseCatalog(courses) {
  if (Array.isArray(courses)) $t = courses;
}


function zy(n) {
  return $t.filter((r) => n.includes(r.id));
}

function bs(n) {
  const chapters = n?.chapters ?? [];
  const r = chapters.filter((u) => u.done).length;
  return {
    done: r,
    total: chapters.length,
    percent: chapters.length ? Math.round((r / chapters.length) * 100) : 0,
    current: chapters.find((u) => !u.done)?.title ?? "全部完成",
  };
}

function Re(n, r = "Assertion error") {
  if (!n) throw Error(r);
}

function mn({ group: n }) {
  const { orientation: r, panels: u } = n;
  return u.reduce(
    (i, d) => (
      (i +=
        r === "horizontal" ? d.element.offsetWidth : d.element.offsetHeight),
      i
    ),
    0,
  );
}

function Xi(n, r) {
  return r.sort(n === "horizontal" ? Ey : Cy);
}

function Ey(n, r) {
  const u = n.element.offsetLeft - r.element.offsetLeft;
  return u !== 0 ? u : n.element.offsetWidth - r.element.offsetWidth;
}

function Cy(n, r) {
  const u = n.element.offsetTop - r.element.offsetTop;
  return u !== 0 ? u : n.element.offsetHeight - r.element.offsetHeight;
}

function Hm(n) {
  return (
    n !== null &&
    typeof n == "object" &&
    "nodeType" in n &&
    n.nodeType === Node.ELEMENT_NODE
  );
}

function Gm(n, r) {
  return {
    x:
      n.x >= r.left && n.x <= r.right
        ? 0
        : Math.min(Math.abs(n.x - r.left), Math.abs(n.x - r.right)),
    y:
      n.y >= r.top && n.y <= r.bottom
        ? 0
        : Math.min(Math.abs(n.y - r.top), Math.abs(n.y - r.bottom)),
  };
}

function _y({ orientation: n, rects: r, targetRect: u }) {
  const i = { x: u.x + u.width / 2, y: u.y + u.height / 2 };
  let d,
    p = Number.MAX_VALUE;
  for (const m of r) {
    const { x: b, y: h } = Gm(i, m),
      x = n === "horizontal" ? b : h;
    x < p && ((p = x), (d = m));
  }
  return (Re(d, "No rect found"), d);
}

function qm(n) {
  const { element: r, orientation: u, panels: i, separators: d } = n,
    p = Xi(
      u,
      Array.from(r.children)
        .filter(Hm)
        .map((y) => ({ element: y })),
    ).map(({ element: y }) => y),
    m = [];
  let b = !1,
    h,
    x = [];
  for (const y of p)
    if (y.hasAttribute("data-panel")) {
      const j = i.find((z) => z.element === y);
      if (j) {
        if (h) {
          const z = h.element.getBoundingClientRect(),
            R = y.getBoundingClientRect();
          let N;
          if (b) {
            const E =
                u === "horizontal"
                  ? new DOMRect(z.right, z.top, 0, z.height)
                  : new DOMRect(z.left, z.bottom, z.width, 0),
              _ =
                u === "horizontal"
                  ? new DOMRect(R.left, R.top, 0, R.height)
                  : new DOMRect(R.left, R.top, R.width, 0);
            switch (x.length) {
              case 0: {
                N = [E, _];
                break;
              }
              case 1: {
                const M = x[0],
                  B = _y({
                    orientation: u,
                    rects: [z, R],
                    targetRect: M.element.getBoundingClientRect(),
                  });
                N = [M, B === z ? _ : E];
                break;
              }
              default: {
                N = x;
                break;
              }
            }
          } else
            x.length
              ? (N = x)
              : (N = [
                  u === "horizontal"
                    ? new DOMRect(z.right, R.top, R.left - z.right, R.height)
                    : new DOMRect(R.left, z.bottom, R.width, R.top - z.bottom),
                ]);
          for (const E of N)
            m.push({
              group: n,
              groupSize: mn({ group: n }),
              panels: [h, j],
              separator: "width" in E ? void 0 : E,
              rect: "width" in E ? E : E.element.getBoundingClientRect(),
            });
        }
        ((b = !1), (h = j), (x = []));
      }
    } else if (y.hasAttribute("data-separator")) {
      const j = d.find((z) => z.element === y);
      j ? x.push(j) : ((h = void 0), (x = []));
    } else b = !0;
  return m;
}

function Dy(n, r) {
  const u = getComputedStyle(n),
    i = parseFloat(u.fontSize);
  return r * i;
}

function My(n, r) {
  const u = getComputedStyle(n.ownerDocument.body),
    i = parseFloat(u.fontSize);
  return r * i;
}

function Ay(n) {
  return (n / 100) * window.innerHeight;
}

function Ty(n) {
  return (n / 100) * window.innerWidth;
}

function Ry(n) {
  switch (typeof n) {
    case "number":
      return [n, "px"];
    case "string": {
      const r = parseFloat(n);
      return n.endsWith("%")
        ? [r, "%"]
        : n.endsWith("px")
          ? [r, "px"]
          : n.endsWith("rem")
            ? [r, "rem"]
            : n.endsWith("em")
              ? [r, "em"]
              : n.endsWith("vh")
                ? [r, "vh"]
                : n.endsWith("vw")
                  ? [r, "vw"]
                  : [r, "%"];
    }
  }
}

function Zo({ groupSize: n, panelElement: r, styleProp: u }) {
  let i;
  const [d, p] = Ry(u);
  switch (p) {
    case "%": {
      i = (d / 100) * n;
      break;
    }
    case "px": {
      i = d;
      break;
    }
    case "rem": {
      i = My(r, d);
      break;
    }
    case "em": {
      i = Dy(r, d);
      break;
    }
    case "vh": {
      i = Ay(d);
      break;
    }
    case "vw": {
      i = Ty(d);
      break;
    }
  }
  return i;
}

function qt(n) {
  return parseFloat(n.toFixed(3));
}

function Hh(n) {
  const { panels: r } = n,
    u = mn({ group: n });
  return u === 0
    ? r.map((i) => ({
        collapsedSize: 0,
        collapsible: i.panelConstraints.collapsible === !0,
        defaultSize: void 0,
        minSize: 0,
        maxSize: 100,
        panelId: i.id,
      }))
    : r.map((i) => {
        const { element: d, panelConstraints: p } = i;
        let m = 0;
        if (p.collapsedSize) {
          const y = Zo({
            groupSize: u,
            panelElement: d,
            styleProp: p.collapsedSize,
          });
          m = qt((y / u) * 100);
        }
        let b;
        if (p.defaultSize) {
          const y = Zo({
            groupSize: u,
            panelElement: d,
            styleProp: p.defaultSize,
          });
          b = qt((y / u) * 100);
        }
        let h = 0;
        if (p.minSize) {
          const y = Zo({ groupSize: u, panelElement: d, styleProp: p.minSize });
          h = qt((y / u) * 100);
        }
        let x = 100;
        if (p.maxSize) {
          const y = Zo({ groupSize: u, panelElement: d, styleProp: p.maxSize });
          x = qt((y / u) * 100);
        }
        return {
          collapsedSize: m,
          collapsible: p.collapsible === !0,
          defaultSize: b,
          minSize: h,
          maxSize: x,
          panelId: i.id,
        };
      });
}

class Ly {
  #e = {};
  addListener(r, u) {
    const i = this.#e[r];
    return (
      i === void 0 ? (this.#e[r] = [u]) : i.includes(u) || i.push(u),
      () => {
        this.removeListener(r, u);
      }
    );
  }
  emit(r, u) {
    const i = this.#e[r];
    if (i !== void 0)
      if (i.length === 1) i[0].call(null, u);
      else {
        let d = !1,
          p = null;
        const m = Array.from(i);
        for (let b = 0; b < m.length; b++) {
          const h = m[b];
          try {
            h.call(null, u);
          } catch (x) {
            p === null && ((d = !0), (p = x));
          }
        }
        if (d) throw p;
      }
  }
  removeAllListeners() {
    this.#e = {};
  }
  removeListener(r, u) {
    const i = this.#e[r];
    if (i !== void 0) {
      const d = i.indexOf(u);
      d >= 0 && i.splice(d, 1);
    }
  }
}

function ct(n, r, u = 0) {
  return Math.abs(qt(n) - qt(r)) <= u;
}

let Lt = {
  cursorFlags: 0,
  interactionState: { state: "inactive" },
  mountedGroups: new Map(),
};

const gl = new Ly();

function Wt() {
  return Lt;
}

function Ot(n) {
  const r = typeof n == "function" ? n(Lt) : n;
  if (Lt === r) return Lt;
  const u = Lt;
  return (
    (Lt = { ...Lt, ...r }),
    r.cursorFlags !== void 0 && gl.emit("cursorFlagsChange", Lt.cursorFlags),
    r.interactionState !== void 0 &&
      gl.emit("interactionStateChange", Lt.interactionState),
    r.mountedGroups !== void 0 &&
      (Lt.mountedGroups.forEach((i, d) => {
        i.derivedPanelConstraints.forEach((p) => {
          if (p.collapsible) {
            const { layout: m } = u.mountedGroups.get(d) ?? {};
            if (m) {
              const b = ct(p.collapsedSize, i.layout[p.panelId]),
                h = ct(p.collapsedSize, m[p.panelId]);
              b &&
                !h &&
                (d.inMemoryLastExpandedPanelSizes[p.panelId] = m[p.panelId]);
            }
          }
        });
      }),
      gl.emit("mountedGroupsChange", Lt.mountedGroups)),
    Lt
  );
}

function Oy(n, r) {
  if (n.length !== r.length) return !1;
  for (let u = 0; u < n.length; u++) if (n[u] != r[u]) return !1;
  return !0;
}

function js(n, r) {
  return ct(n, r) ? 0 : n > r ? 1 : -1;
}

function un({ panelConstraints: n, size: r }) {
  const {
    collapsedSize: u = 0,
    collapsible: i,
    maxSize: d = 100,
    minSize: p = 0,
  } = n;
  if (js(r, p) < 0)
    if (i) {
      const m = (u + p) / 2;
      js(r, m) < 0 ? (r = u) : (r = p);
    } else r = p;
  return ((r = Math.min(d, r)), (r = qt(r)), r);
}

function ws({
  delta: n,
  initialLayout: r,
  panelConstraints: u,
  pivotIndices: i,
  prevLayout: d,
  trigger: p,
}) {
  if (ct(n, 0)) return r;
  const m = Object.values(r),
    b = Object.values(d),
    h = [...m],
    [x, y] = i;
  (Re(x != null, "Invalid first pivot index"),
    Re(y != null, "Invalid second pivot index"));
  let j = 0;
  if (p === "keyboard") {
    {
      const N = n < 0 ? y : x,
        E = u[N];
      Re(E, `Panel constraints not found for index ${N}`);
      const { collapsedSize: _ = 0, collapsible: M, minSize: B = 0 } = E;
      if (M) {
        const Q = m[N];
        if (
          (Re(Q != null, `Previous layout not found for panel index ${N}`),
          ct(Q, _))
        ) {
          const H = B - Q;
          js(H, Math.abs(n)) > 0 && (n = n < 0 ? 0 - H : H);
        }
      }
    }
    {
      const N = n < 0 ? x : y,
        E = u[N];
      Re(E, `No panel constraints found for index ${N}`);
      const { collapsedSize: _ = 0, collapsible: M, minSize: B = 0 } = E;
      if (M) {
        const Q = m[N];
        if (
          (Re(Q != null, `Previous layout not found for panel index ${N}`),
          ct(Q, B))
        ) {
          const H = Q - _;
          js(H, Math.abs(n)) > 0 && (n = n < 0 ? 0 - H : H);
        }
      }
    }
  }
  {
    const N = n < 0 ? 1 : -1;
    let E = n < 0 ? y : x,
      _ = 0;
    for (;;) {
      const B = m[E];
      Re(B != null, `Previous layout not found for panel index ${E}`);
      const Q = un({ panelConstraints: u[E], size: 100 }) - B;
      if (((_ += Q), (E += N), E < 0 || E >= u.length)) break;
    }
    const M = Math.min(Math.abs(n), Math.abs(_));
    n = n < 0 ? 0 - M : M;
  }
  {
    let N = n < 0 ? x : y;
    for (; N >= 0 && N < u.length; ) {
      const E = Math.abs(n) - Math.abs(j),
        _ = m[N];
      Re(_ != null, `Previous layout not found for panel index ${N}`);
      const M = _ - E,
        B = un({ panelConstraints: u[N], size: M });
      if (
        !ct(_, B) &&
        ((j += _ - B),
        (h[N] = B),
        j
          .toFixed(3)
          .localeCompare(Math.abs(n).toFixed(3), void 0, { numeric: !0 }) >= 0)
      )
        break;
      n < 0 ? N-- : N++;
    }
  }
  if (Oy(b, h)) return d;
  {
    const N = n < 0 ? y : x,
      E = m[N];
    Re(E != null, `Previous layout not found for panel index ${N}`);
    const _ = E + j,
      M = un({ panelConstraints: u[N], size: _ });
    if (((h[N] = M), !ct(M, _))) {
      let B = _ - M,
        Q = n < 0 ? y : x;
      for (; Q >= 0 && Q < u.length; ) {
        const H = h[Q];
        Re(H != null, `Previous layout not found for panel index ${Q}`);
        const $ = H + B,
          O = un({ panelConstraints: u[Q], size: $ });
        if ((ct(H, O) || ((B -= O - H), (h[Q] = O)), ct(B, 0))) break;
        n > 0 ? Q-- : Q++;
      }
    }
  }
  const z = Object.values(h).reduce((N, E) => E + N, 0);
  if (!ct(z, 100, 0.1)) return d;
  const R = Object.keys(d);
  return h.reduce((N, E, _) => ((N[R[_]] = E), N), {});
}

function Io(n) {
  const r = n.parentElement;
  Re(r, "Parent group element not found");
  const { mountedGroups: u } = Wt();
  for (const [i] of u) if (i.element === r) return i;
  throw Error("Could not find parent Group for separator element");
}

function yn(n, r) {
  if (Object.keys(n).length !== Object.keys(r).length) return !1;
  for (const u in n) if (r[u] === void 0 || js(n[u], r[u]) !== 0) return !1;
  return !0;
}

function bl({ layout: n, panelConstraints: r }) {
  const u = [...Object.values(n)],
    i = u.reduce((m, b) => m + b, 0);
  if (u.length !== r.length)
    throw Error(
      `Invalid ${r.length} panel layout: ${u.map((m) => `${m}%`).join(", ")}`,
    );
  if (!ct(i, 100) && u.length > 0)
    for (let m = 0; m < r.length; m++) {
      const b = u[m];
      Re(b != null, `No layout data found for index ${m}`);
      const h = (100 / i) * b;
      u[m] = h;
    }
  let d = 0;
  for (let m = 0; m < r.length; m++) {
    const b = u[m];
    Re(b != null, `No layout data found for index ${m}`);
    const h = un({ panelConstraints: r[m], size: b });
    b != h && ((d += b - h), (u[m] = h));
  }
  if (!ct(d, 0))
    for (let m = 0; m < r.length; m++) {
      const b = u[m];
      Re(b != null, `No layout data found for index ${m}`);
      const h = b + d,
        x = un({ panelConstraints: r[m], size: h });
      if (b !== x && ((d -= x - b), (u[m] = x), ct(d, 0))) break;
    }
  const p = Object.keys(n);
  return u.reduce((m, b, h) => ((m[p[h]] = b), m), {});
}

function Qm({ groupId: n }) {
  const r = () => {
    const { mountedGroups: u } = Wt();
    for (const [i, d] of u) if (i.id === n) return { group: i, ...d };
    throw Error(`Could not find Group with id "${n}"`);
  };
  return {
    getLayout() {
      const { defaultLayoutDeferred: u, layout: i } = r();
      return u ? {} : i;
    },
    setLayout(u) {
      const {
          defaultLayoutDeferred: i,
          derivedPanelConstraints: d,
          group: p,
          layout: m,
          separatorToPanels: b,
        } = r(),
        h = bl({ layout: u, panelConstraints: d });
      return i
        ? m
        : (yn(m, h) ||
            Ot((x) => ({
              mountedGroups: new Map(x.mountedGroups).set(p, {
                defaultLayoutDeferred: i,
                derivedPanelConstraints: d,
                layout: h,
                separatorToPanels: b,
              }),
            })),
          h);
    },
  };
}

function Ym(n) {
  const { mountedGroups: r } = Wt(),
    u = r.get(n);
  return (Re(u, `Mounted Group ${n.id} not found`), u);
}

function hl(n, r) {
  const u = Io(n),
    i = Ym(u),
    d = u.separators.find((y) => y.element === n);
  Re(d, "Matching separator not found");
  const p = i.separatorToPanels.get(d);
  Re(p, "Matching panels not found");
  const m = p.map((y) => u.panels.indexOf(y)),
    b = Qm({ groupId: u.id }).getLayout(),
    h = ws({
      delta: r,
      initialLayout: b,
      panelConstraints: i.derivedPanelConstraints,
      pivotIndices: m,
      prevLayout: b,
      trigger: "keyboard",
    }),
    x = bl({ layout: h, panelConstraints: i.derivedPanelConstraints });
  yn(b, x) ||
    Ot((y) => ({
      mountedGroups: new Map(y.mountedGroups).set(u, {
        defaultLayoutDeferred: i.defaultLayoutDeferred,
        derivedPanelConstraints: i.derivedPanelConstraints,
        layout: x,
        separatorToPanels: i.separatorToPanels,
      }),
    }));
}

function Gh(n) {
  if (n.defaultPrevented) return;
  const r = n.currentTarget,
    u = Io(r);
  if (!u.disabled)
    switch (n.key) {
      case "ArrowDown": {
        (n.preventDefault(), u.orientation === "vertical" && hl(r, 5));
        break;
      }
      case "ArrowLeft": {
        (n.preventDefault(), u.orientation === "horizontal" && hl(r, -5));
        break;
      }
      case "ArrowRight": {
        (n.preventDefault(), u.orientation === "horizontal" && hl(r, 5));
        break;
      }
      case "ArrowUp": {
        (n.preventDefault(), u.orientation === "vertical" && hl(r, -5));
        break;
      }
      case "End": {
        (n.preventDefault(), hl(r, 100));
        break;
      }
      case "Enter": {
        n.preventDefault();
        const i = Io(r),
          {
            derivedPanelConstraints: d,
            layout: p,
            separatorToPanels: m,
          } = Ym(i),
          b = i.separators.find((j) => j.element === r);
        Re(b, "Matching separator not found");
        const h = m.get(b);
        Re(h, "Matching panels not found");
        const x = h[0],
          y = d.find((j) => j.panelId === x.id);
        if ((Re(y, "Panel metadata not found"), y.collapsible)) {
          const j = p[x.id],
            z =
              y.collapsedSize === j
                ? (i.inMemoryLastExpandedPanelSizes[x.id] ?? y.minSize)
                : y.collapsedSize;
          hl(r, z - j);
        }
        break;
      }
      case "F6": {
        n.preventDefault();
        const i = Io(r).separators.map((m) => m.element),
          d = Array.from(i).findIndex((m) => m === n.currentTarget);
        Re(d !== null, "Index not found");
        const p = n.shiftKey
          ? d > 0
            ? d - 1
            : i.length - 1
          : d + 1 < i.length
            ? d + 1
            : 0;
        i[p].focus();
        break;
      }
      case "Home": {
        (n.preventDefault(), hl(r, -100));
        break;
      }
    }
}

const Uy = (n) => n,
  Hi = () => {},
  Vm = 1,
  Xm = 2,
  Zm = 4,
  Km = 8,
  qh = { coarse: 10, precise: 5 };

function By(n, r, u) {
  let i,
    d = { x: 1 / 0, y: 1 / 0 };
  for (const p of r) {
    const m = Gm(u, p.rect);
    switch (n) {
      case "horizontal": {
        m.x <= d.x && ((i = p), (d = m));
        break;
      }
      case "vertical": {
        m.y <= d.y && ((i = p), (d = m));
        break;
      }
    }
  }
  return i ? { distance: d, hitRegion: i } : void 0;
}

let Ko;

function Hy() {
  return (
    Ko === void 0 &&
      (typeof matchMedia == "function"
        ? (Ko = !!matchMedia("(pointer:coarse)").matches)
        : (Ko = !1)),
    Ko
  );
}

function Gy(n) {
  return (
    n !== null &&
    typeof n == "object" &&
    "nodeType" in n &&
    n.nodeType === Node.DOCUMENT_FRAGMENT_NODE
  );
}

function qy(n, r) {
  if (n === r) throw new Error("Cannot compare node with itself");
  const u = { a: Vh(n), b: Vh(r) };
  let i;
  for (; u.a.at(-1) === u.b.at(-1); )
    ((n = u.a.pop()), (r = u.b.pop()), (i = n));
  Re(
    i,
    "Stacking order can only be calculated for elements with a common ancestor",
  );
  const d = { a: Yh(Qh(u.a)), b: Yh(Qh(u.b)) };
  if (d.a === d.b) {
    const p = i.childNodes,
      m = { a: u.a.at(-1), b: u.b.at(-1) };
    let b = p.length;
    for (; b--; ) {
      const h = p[b];
      if (h === m.a) return 1;
      if (h === m.b) return -1;
    }
  }
  return Math.sign(d.a - d.b);
}

const Qy =
  /\b(?:position|zIndex|opacity|transform|webkitTransform|mixBlendMode|filter|webkitFilter|isolation)\b/;

function Yy(n) {
  const r = getComputedStyle($m(n) ?? n).display;
  return r === "flex" || r === "inline-flex";
}

function Vy(n) {
  const r = getComputedStyle(n);
  return !!(
    r.position === "fixed" ||
    (r.zIndex !== "auto" && (r.position !== "static" || Yy(n))) ||
    +r.opacity < 1 ||
    ("transform" in r && r.transform !== "none") ||
    ("webkitTransform" in r && r.webkitTransform !== "none") ||
    ("mixBlendMode" in r && r.mixBlendMode !== "normal") ||
    ("filter" in r && r.filter !== "none") ||
    ("webkitFilter" in r && r.webkitFilter !== "none") ||
    ("isolation" in r && r.isolation === "isolate") ||
    Qy.test(r.willChange) ||
    r.webkitOverflowScrolling === "touch"
  );
}

function Qh(n) {
  let r = n.length;
  for (; r--; ) {
    const u = n[r];
    if ((Re(u, "Missing node"), Vy(u))) return u;
  }
  return null;
}

function Yh(n) {
  return (n && Number(getComputedStyle(n).zIndex)) || 0;
}

function Vh(n) {
  const r = [];
  for (; n; ) (r.push(n), (n = $m(n)));
  return r;
}

function $m(n) {
  const { parentNode: r } = n;
  return Gy(r) ? r.host : r;
}

function Xy(n, r) {
  return (
    n.x < r.x + r.width &&
    n.x + n.width > r.x &&
    n.y < r.y + r.height &&
    n.y + n.height > r.y
  );
}

function Zy({ groupElement: n, hitRegion: r, pointerEventTarget: u }) {
  if (!Hm(u) || u.contains(n) || n.contains(u)) return !0;
  if (qy(u, n) > 0) {
    let i = u;
    for (; i; ) {
      if (i.contains(n)) return !0;
      if (Xy(i.getBoundingClientRect(), r)) return !1;
      i = i.parentElement;
    }
  }
  return !0;
}

function Jm(n, r) {
  const u = [];
  return (
    r.forEach((i, d) => {
      if (d.disabled) return;
      const p = Hy() ? qh.coarse : qh.precise,
        m = qm(d),
        b = By(d.orientation, m, { x: n.clientX, y: n.clientY });
      b &&
        b.distance.x <= p &&
        b.distance.y <= p &&
        Zy({
          groupElement: d.element,
          hitRegion: b.hitRegion.rect,
          pointerEventTarget: n.target,
        }) &&
        u.push(b.hitRegion);
    }),
    u
  );
}

function Xh(n) {
  if (n.defaultPrevented) return;
  const { mountedGroups: r } = Wt(),
    u = Jm(n, r),
    i = new Set(),
    d = new Set(),
    p = new Set(),
    m = new Map();
  let b = !1;
  (u.forEach((h) => {
    (i.add(h.group),
      h.panels.forEach((y) => {
        d.add(y);
      }),
      h.separator &&
        (p.add(h.separator), b || ((b = !0), h.separator.element.focus())));
    const x = r.get(h.group);
    x && m.set(h.group, x.layout);
  }),
    Ot({
      interactionState: {
        hitRegions: u,
        initialLayoutMap: m,
        pointerDownAtPoint: { x: n.clientX, y: n.clientY },
        state: "active",
      },
    }),
    u.length && n.preventDefault());
}

function Ky({ cursorFlags: n, groups: r, state: u }) {
  let i = 0,
    d = 0;
  switch (u) {
    case "active":
    case "hover":
      r.forEach((p) => {
        if (!p.disableCursor)
          switch (p.orientation) {
            case "horizontal": {
              i++;
              break;
            }
            case "vertical": {
              d++;
              break;
            }
          }
      });
  }
  if (i === 0 && d === 0) return null;
  switch (u) {
    case "active": {
      const p = (n & Vm) !== 0,
        m = (n & Xm) !== 0,
        b = (n & Zm) !== 0,
        h = (n & Km) !== 0;
      if (n) {
        if (p) return b ? "se-resize" : h ? "ne-resize" : "e-resize";
        if (m) return b ? "sw-resize" : h ? "nw-resize" : "w-resize";
        if (b) return "s-resize";
        if (h) return "n-resize";
      }
      break;
    }
  }
  return i > 0 && d > 0 ? "move" : i > 0 ? "ew-resize" : "ns-resize";
}

const Zh = new WeakMap();

function cu(n) {
  if (n.defaultView === null || n.defaultView === void 0) return;
  let { prevStyle: r, styleSheet: u } = Zh.get(n) ?? {};
  u === void 0 &&
    ((u = new n.defaultView.CSSStyleSheet()), (n.adoptedStyleSheets = [u]));
  const { cursorFlags: i, interactionState: d } = Wt();
  switch (d.state) {
    case "active":
    case "hover": {
      const p = Ky({
          cursorFlags: i,
          groups: d.hitRegions.map((b) => b.group),
          state: d.state,
        }),
        m = `*{cursor: ${p} !important; ${d.state === "active" ? "touch-action: none;" : ""} }`;
      if (r === m) return;
      ((r = m),
        p
          ? u.cssRules.length === 0
            ? u.insertRule(m)
            : u.replaceSync(m)
          : u.cssRules.length === 1 && u.deleteRule(0));
      break;
    }
    case "inactive": {
      ((r = void 0), u.cssRules.length === 1 && u.deleteRule(0));
      break;
    }
  }
  Zh.set(n, { prevStyle: r, styleSheet: u });
}

function Pm({
  document: n,
  event: r,
  hitRegions: u,
  initialLayoutMap: i,
  mountedGroups: d,
  pointerDownAtPoint: p,
}) {
  let m = 0;
  const b = new Map(d);
  (u.forEach((h) => {
    const { group: x, groupSize: y } = h,
      { disableCursor: j, orientation: z, panels: R } = x;
    let N = 0;
    p
      ? z === "horizontal"
        ? (N = ((r.clientX - p.x) / y) * 100)
        : (N = ((r.clientY - p.y) / y) * 100)
      : z === "horizontal"
        ? (N = r.clientX < 0 ? -100 : 100)
        : (N = r.clientY < 0 ? -100 : 100);
    const E = i.get(x),
      {
        defaultLayoutDeferred: _,
        derivedPanelConstraints: M,
        layout: B,
        separatorToPanels: Q,
      } = d.get(x) ?? { defaultLayoutDeferred: !1 };
    if (M && E && B && Q) {
      const H = ws({
        delta: N,
        initialLayout: E,
        panelConstraints: M,
        pivotIndices: h.panels.map(($) => R.indexOf($)),
        prevLayout: B,
        trigger: "mouse-or-touch",
      });
      if (yn(H, B)) {
        if (N !== 0 && !j)
          switch (z) {
            case "horizontal": {
              m |= N < 0 ? Vm : Xm;
              break;
            }
            case "vertical": {
              m |= N < 0 ? Zm : Km;
              break;
            }
          }
      } else {
        b.set(h.group, {
          defaultLayoutDeferred: _,
          derivedPanelConstraints: M,
          layout: H,
          separatorToPanels: Q,
        });
        const $ = h.group.panels.map(({ id: O }) => O).join(",");
        h.group.inMemoryLayouts[$] = H;
      }
    }
  }),
    Ot({ cursorFlags: m, mountedGroups: b }),
    cu(n));
}

function Kh(n) {
  const { interactionState: r, mountedGroups: u } = Wt();
  r.state === "active" &&
    Pm({
      document: n.currentTarget,
      event: n,
      hitRegions: r.hitRegions,
      initialLayoutMap: r.initialLayoutMap,
      mountedGroups: u,
    });
}

function $h(n) {
  if (n.defaultPrevented) return;
  const { interactionState: r, mountedGroups: u } = Wt();
  switch (r.state) {
    case "active": {
      if (n.buttons === 0) {
        Ot((i) =>
          i.interactionState.state === "inactive"
            ? i
            : { cursorFlags: 0, interactionState: { state: "inactive" } },
        );
        return;
      }
      Pm({
        document: n.currentTarget,
        event: n,
        hitRegions: r.hitRegions,
        initialLayoutMap: r.initialLayoutMap,
        mountedGroups: u,
        pointerDownAtPoint: r.pointerDownAtPoint,
      });
      break;
    }
    default: {
      const i = Jm(n, u);
      (i.length === 0
        ? r.state !== "inactive" &&
          Ot({ interactionState: { state: "inactive" } })
        : Ot({ interactionState: { hitRegions: i, state: "hover" } }),
        cu(n.currentTarget));
      break;
    }
  }
}

function Jh(n) {
  if (n.defaultPrevented) return;
  n.preventDefault();
  const { interactionState: r } = Wt();
  r.state === "active" &&
    (Ot({ cursorFlags: 0, interactionState: { state: "inactive" } }),
    cu(n.currentTarget));
}

function Ph(n) {
  let r = 0,
    u = 0;
  const i = {};
  for (const p of n)
    if (p.defaultSize !== void 0) {
      r++;
      const m = qt(p.defaultSize);
      ((u += m), (i[p.panelId] = m));
    } else i[p.panelId] = void 0;
  const d = n.length - r;
  if (d !== 0) {
    const p = qt((100 - u) / d);
    for (const m of n) m.defaultSize === void 0 && (i[m.panelId] = p);
  }
  return i;
}

function $y(n, r, u) {
  const i = u[0];
  if (!i) return;
  const d = n.panels.find((h) => h.element === r);
  if (!d || !d.onResize) return;
  const p = mn({ group: n }),
    m = d.mutableValues.prevSize,
    b = { asPercentage: qt((i.inlineSize / p) * 100), inPixels: i.inlineSize };
  ((d.mutableValues.prevSize = b), d.onResize(b, d.id, m));
}

function Jy(n, r) {
  if (Object.keys(n).length !== Object.keys(r).length) return !1;
  for (const u in n) if (n[u] !== r[u]) return !1;
  return !0;
}

function Py(n, r) {
  const u = n.map((d) => d.id),
    i = Object.keys(r);
  if (u.length !== i.length) return !1;
  for (const d of u) if (!i.includes(d)) return !1;
  return !0;
}

const on = new Map();

function Wy(n) {
  let r = !0;
  Re(n.element.ownerDocument.defaultView, "Cannot register an unmounted Group");
  const u = n.element.ownerDocument.defaultView.ResizeObserver,
    i = new Set(),
    d = new Set(),
    p = new u((N) => {
      for (const E of N) {
        const { borderBoxSize: _, target: M } = E;
        if (M === n.element) {
          if (r) {
            if (mn({ group: n }) === 0) return;
            Ot((B) => {
              const Q = B.mountedGroups.get(n);
              if (Q) {
                const H = Hh(n),
                  $ = Q.defaultLayoutDeferred ? Ph(H) : Q.layout,
                  O = bl({ layout: $, panelConstraints: H });
                return !Q.defaultLayoutDeferred &&
                  yn($, O) &&
                  Jy(Q.derivedPanelConstraints, H)
                  ? B
                  : {
                      mountedGroups: new Map(B.mountedGroups).set(n, {
                        defaultLayoutDeferred: !1,
                        derivedPanelConstraints: H,
                        layout: O,
                        separatorToPanels: Q.separatorToPanels,
                      }),
                    };
              }
              return B;
            });
          }
        } else $y(n, M, _);
      }
    });
  (p.observe(n.element),
    n.panels.forEach((N) => {
      (Re(
        !i.has(N.id),
        `Panel ids must be unique; id "${N.id}" was used more than once`,
      ),
        i.add(N.id),
        N.onResize && p.observe(N.element));
    }));
  const m = mn({ group: n }),
    b = Hh(n),
    h = n.panels.map(({ id: N }) => N).join(",");
  let x = n.defaultLayout;
  x && (Py(n.panels, x) || (x = void 0));
  const y = n.inMemoryLayouts[h] ?? x ?? Ph(b),
    j = bl({ layout: y, panelConstraints: b }),
    z = qm(n),
    R = n.element.ownerDocument;
  return (
    Ot((N) => {
      const E = new Map();
      return (
        on.set(R, (on.get(R) ?? 0) + 1),
        z.forEach((_) => {
          _.separator && E.set(_.separator, _.panels);
        }),
        {
          mountedGroups: new Map(N.mountedGroups).set(n, {
            defaultLayoutDeferred: m === 0,
            derivedPanelConstraints: b,
            layout: j,
            separatorToPanels: E,
          }),
        }
      );
    }),
    n.separators.forEach((N) => {
      (Re(
        !d.has(N.id),
        `Separator ids must be unique; id "${N.id}" was used more than once`,
      ),
        d.add(N.id),
        N.element.addEventListener("keydown", Gh));
    }),
    on.get(R) === 1 &&
      (R.addEventListener("pointerdown", Xh),
      R.addEventListener("pointerleave", Kh),
      R.addEventListener("pointermove", $h),
      R.addEventListener("pointerup", Jh)),
    function () {
      ((r = !1),
        on.set(R, Math.max(0, (on.get(R) ?? 0) - 1)),
        Ot((N) => {
          const E = new Map(N.mountedGroups);
          return (E.delete(n), { mountedGroups: E });
        }),
        n.separators.forEach((N) => {
          N.element.removeEventListener("keydown", Gh);
        }),
        on.get(R) ||
          (R.removeEventListener("pointerdown", Xh),
          R.removeEventListener("pointerleave", Kh),
          R.removeEventListener("pointermove", $h),
          R.removeEventListener("pointerup", Jh)),
        p.disconnect());
    }
  );
}

function Fy() {
  const [n, r] = React.useState({}),
    u = React.useCallback(() => r({}), []);
  return [n, u];
}

function ru(n) {
  const r = React.useId();
  return `${n ?? r}`;
}

const vl = typeof window < "u" ? React.useLayoutEffect : React.useEffect;

function iu(n) {
  const r = React.useRef(n);
  return (
    vl(() => {
      r.current = n;
    }, [n]),
    React.useCallback((...u) => r.current?.(...u), [r])
  );
}

function uu(...n) {
  return iu((r) => {
    n.forEach((u) => {
      if (u)
        switch (typeof u) {
          case "function": {
            u(r);
            break;
          }
          case "object": {
            u.current = r;
            break;
          }
        }
    });
  });
}

function Iy(n) {
  const r = React.useRef({ ...n });
  return (
    vl(() => {
      for (const u in n) r.current[u] = n[u];
    }, [n]),
    r.current
  );
}

const Wm = "--react-resizable-panels--panel--pointer-events";

function Fm(n, r) {
  const u = n.replace(/[^a-zA-Z0-9\-_]/g, ""),
    i = r.replace(/[^a-zA-Z0-9\-_]/g, "");
  return `--react-resizable-panels--${u}--${i}`;
}

const Im = React.createContext(null);

function ev(n, r) {
  const u = React.useRef({ getLayout: () => ({}), setLayout: Uy });
  (React.useImperativeHandle(r, () => u.current, []),
    vl(() => {
      Object.assign(u.current, Qm({ groupId: n }));
    }));
}

function ex({
  children: n,
  className: r,
  defaultLayout: u,
  disableCursor: i,
  disabled: d,
  elementRef: p,
  groupRef: m,
  id: b,
  onLayoutChange: h,
  orientation: x = "horizontal",
  style: y,
  ...j
}) {
  const z = React.useRef({}),
    R = iu((se) => {
      yn(z.current, se) || ((z.current = se), h?.(se));
    }),
    N = ru(b),
    E = React.useRef(null),
    [_, M] = React.useState(!1),
    [B, Q] = React.useState(u ?? {}),
    [H, $] = Fy(),
    O = React.useRef({
      lastExpandedPanelSizes: {},
      layouts: {},
      panels: [],
      separators: [],
    }),
    P = uu(E, p);
  ev(N, m);
  const G = React.useMemo(
      () => ({
        id: N,
        orientation: x,
        registerPanel: (se) => {
          const fe = O.current;
          return (
            (fe.panels = Xi(x, [...fe.panels, se])),
            $(),
            () => {
              ((fe.panels = fe.panels.filter((xe) => xe !== se)), $());
            }
          );
        },
        registerSeparator: (se) => {
          const fe = O.current;
          return (
            (fe.separators = Xi(x, [...fe.separators, se])),
            $(),
            () => {
              ((fe.separators = fe.separators.filter((xe) => xe !== se)), $());
            }
          );
        },
      }),
      [N, $, x],
    ),
    ne = Iy({ defaultLayout: u, disableCursor: i }),
    be = React.useRef(null);
  (vl(() => {
    const se = E.current;
    if (se === null) return;
    const fe = O.current,
      xe = {
        defaultLayout: ne.defaultLayout,
        disableCursor: !!ne.disableCursor,
        disabled: !!d,
        element: se,
        id: N,
        inMemoryLastExpandedPanelSizes: O.current.lastExpandedPanelSizes,
        inMemoryLayouts: O.current.layouts,
        orientation: x,
        panels: fe.panels,
        separators: fe.separators,
      };
    be.current = xe;
    const Se = Wy(xe),
      D = Wt().mountedGroups.get(xe);
    if (D) {
      const {
        defaultLayoutDeferred: W,
        derivedPanelConstraints: ae,
        layout: S,
      } = D;
      !W && ae.length > 0 && (Q(S), R?.(S));
    }
    const K = gl.addListener("interactionStateChange", (W) => {
        W.state === "active"
          ? M(W.hitRegions.some((ae) => ae.group === xe))
          : M(!1);
      }),
      Z = gl.addListener("mountedGroupsChange", (W) => {
        const ae = W.get(xe);
        if (ae) {
          const {
            defaultLayoutDeferred: S,
            derivedPanelConstraints: Y,
            layout: J,
          } = ae;
          if (S || Y.length === 0) return;
          (Q(J), R?.(J));
        }
      });
    return () => {
      ((be.current = null), Se(), K(), Z());
    };
  }, [d, N, R, x, H, ne]),
    React.useEffect(() => {
      const se = be.current;
      se && ((se.defaultLayout = u), (se.disableCursor = !!i));
    }));
  const ke = { [Wm]: _ ? "none" : void 0 };
  for (const se in B) {
    const fe = Fm(N, se),
      xe = B[se];
    ke[fe] = xe;
  }
  return jsxRuntime.jsx(Im.Provider, {
    value: G,
    children: jsxRuntime.jsx("div", {
      ...j,
      "aria-orientation": x,
      className: r,
      "data-group": !0,
      "data-testid": N,
      id: N,
      ref: P,
      style: {
        ...y,
        ...ke,
        display: "flex",
        flexDirection: x === "horizontal" ? "row" : "column",
        flexWrap: "nowrap",
      },
      children: n,
    }),
  });
}

ex.displayName = "Group";

function du() {
  const n = React.useContext(Im);
  return (
    Re(
      n,
      "Group Context not found; did you render a Panel or Separator outside of a Group?",
    ),
    n
  );
}

function tv({ groupId: n, panelId: r }) {
  const u = () => {
      const { mountedGroups: b } = Wt();
      for (const [
        h,
        {
          defaultLayoutDeferred: x,
          derivedPanelConstraints: y,
          layout: j,
          separatorToPanels: z,
        },
      ] of b)
        if (h.id === n)
          return {
            defaultLayoutDeferred: x,
            derivedPanelConstraints: y,
            group: h,
            layout: j,
            separatorToPanels: z,
          };
      throw Error(`Group ${n} not found`);
    },
    i = () => {
      const b = u().derivedPanelConstraints.find((h) => h.panelId === r);
      if (b !== void 0) return b;
      throw Error(`Panel constraints not found for Panel ${r}`);
    },
    d = () => {
      const b = u().group.panels.find((h) => h.id === r);
      if (b !== void 0) return b;
      throw Error(`Layout not found for Panel ${r}`);
    },
    p = () => {
      const b = u().layout[r];
      if (b !== void 0) return b;
      throw Error(`Layout not found for Panel ${r}`);
    },
    m = (b) => {
      const h = p();
      if (b === h) return;
      const {
          defaultLayoutDeferred: x,
          derivedPanelConstraints: y,
          group: j,
          layout: z,
          separatorToPanels: R,
        } = u(),
        N = j.panels.findIndex((B) => B.id === r),
        E = N === j.panels.length - 1,
        _ = ws({
          delta: E ? h - b : b - h,
          initialLayout: z,
          panelConstraints: y,
          pivotIndices: E ? [N - 1, N] : [N, N + 1],
          prevLayout: z,
          trigger: "imperative-api",
        }),
        M = bl({ layout: _, panelConstraints: y });
      yn(z, M) ||
        Ot((B) => ({
          mountedGroups: new Map(B.mountedGroups).set(j, {
            defaultLayoutDeferred: x,
            derivedPanelConstraints: y,
            layout: M,
            separatorToPanels: R,
          }),
        }));
    };
  return {
    collapse: () => {
      const { collapsible: b, collapsedSize: h } = i(),
        { mutableValues: x } = d(),
        y = p();
      b && y !== h && ((x.expandToSize = y), m(h));
    },
    expand: () => {
      const { collapsible: b, collapsedSize: h, minSize: x } = i(),
        { mutableValues: y } = d(),
        j = p();
      if (b && j === h) {
        let z = y.expandToSize ?? x;
        (z === 0 && (z = 1), m(z));
      }
    },
    getSize: () => {
      const { group: b } = u(),
        h = p(),
        { element: x } = d(),
        y = b.orientation === "horizontal" ? x.offsetWidth : x.offsetHeight;
      return { asPercentage: h, inPixels: y };
    },
    isCollapsed: () => {
      const { collapsible: b, collapsedSize: h } = i(),
        x = p();
      return b && ct(h, x);
    },
    resize: (b) => {
      if (p() !== b) {
        let h;
        switch (typeof b) {
          case "number": {
            const { group: x } = u(),
              y = mn({ group: x });
            h = qt((b / y) * 100);
            break;
          }
          case "string": {
            h = parseFloat(b);
            break;
          }
        }
        m(h);
      }
    },
  };
}

function av(n, r) {
  const { id: u } = du(),
    i = React.useRef({
      collapse: Hi,
      expand: Hi,
      getSize: () => ({ asPercentage: 0, inPixels: 0 }),
      isCollapsed: () => !1,
      resize: Hi,
    });
  (React.useImperativeHandle(r, () => i.current, []),
    vl(() => {
      Object.assign(i.current, tv({ groupId: u, panelId: n }));
    }));
}

function tx({
  children: n,
  className: r,
  collapsedSize: u = "0%",
  collapsible: i = !1,
  defaultSize: d,
  elementRef: p,
  id: m,
  maxSize: b = "100%",
  minSize: h = "0%",
  onResize: x,
  panelRef: y,
  style: j,
  ...z
}) {
  const R = !!m,
    N = ru(m),
    E = React.useRef(null),
    _ = uu(E, p),
    { id: M, registerPanel: B } = du(),
    Q = x !== null,
    H = iu((O, P, G) => {
      x?.(O, m, G);
    });
  (vl(() => {
    const O = E.current;
    if (O !== null)
      return B({
        element: O,
        id: N,
        idIsStable: R,
        mutableValues: { expandToSize: void 0, prevSize: void 0 },
        onResize: Q ? H : void 0,
        panelConstraints: {
          collapsedSize: u,
          collapsible: i,
          defaultSize: d,
          maxSize: b,
          minSize: h,
        },
      });
  }, [u, i, d, Q, N, R, b, h, H, B]),
    av(N, y));
  const $ = Fm(M, N);
  return jsxRuntime.jsx("div", {
    ...z,
    "data-panel": !0,
    "data-testid": N,
    id: N,
    ref: _,
    style: {
      ...lv,
      flexBasis: 0,
      flexGrow: `var(${$}, 1)`,
      flexShrink: 1,
      overflow: "hidden",
      pointerEvents: `var(${Wm})`,
    },
    children: jsxRuntime.jsx("div", {
      className: r,
      style: { width: "100%", height: "100%", ...j },
      children: n,
    }),
  });
}

tx.displayName = "Panel";

const lv = {
  minHeight: "unset",
  maxHeight: "unset",
  height: "unset",
  minWidth: "unset",
  maxWidth: "unset",
  width: "unset",
  flex: "unset",
  flexBasis: "unset",
  flexShrink: "unset",
  flexGrow: "unset",
  border: "unset",
  borderWidth: "unset",
  padding: "unset",
  margin: "unset",
};

function nv({ layout: n, panelConstraints: r, panelId: u, panelIndex: i }) {
  let d, p;
  const m = n[u],
    b = r.find((h) => h.panelId === u);
  if (b) {
    const h = b.maxSize,
      x = (p = b.collapsible ? b.collapsedSize : b.minSize),
      y = [i, i + 1];
    ((p = bl({
      layout: ws({
        delta: x - m,
        initialLayout: n,
        panelConstraints: r,
        pivotIndices: y,
        prevLayout: n,
        trigger: "keyboard",
      }),
      panelConstraints: r,
    })[u]),
      (d = bl({
        layout: ws({
          delta: h - m,
          initialLayout: n,
          panelConstraints: r,
          pivotIndices: y,
          prevLayout: n,
          trigger: "keyboard",
        }),
        panelConstraints: r,
      })[u]));
  }
  return { valueControls: u, valueMax: d, valueMin: p, valueNow: m };
}

function ax({
  children: n,
  className: r,
  elementRef: u,
  id: i,
  style: d,
  ...p
}) {
  const m = ru(i),
    [b, h] = React.useState({}),
    [x, y] = React.useState("inactive"),
    j = React.useRef(null),
    z = uu(j, u),
    { id: R, orientation: N, registerSeparator: E } = du(),
    _ = N === "horizontal" ? "vertical" : "horizontal";
  return (
    vl(() => {
      const M = j.current;
      if (M !== null) {
        const B = { element: M, id: m },
          Q = E(B),
          H = gl.addListener("interactionStateChange", (O) => {
            y(
              O.state !== "inactive" &&
                O.hitRegions.some((P) => P.separator === B)
                ? O.state
                : "inactive",
            );
          }),
          $ = gl.addListener("mountedGroupsChange", (O) => {
            O.forEach(
              (
                {
                  derivedPanelConstraints: P,
                  layout: G,
                  separatorToPanels: ne,
                },
                be,
              ) => {
                if (be.id === R) {
                  const ke = ne.get(B);
                  if (ke) {
                    const se = ke[0],
                      fe = be.panels.indexOf(se);
                    h(
                      nv({
                        layout: G,
                        panelConstraints: P,
                        panelId: se.id,
                        panelIndex: fe,
                      }),
                    );
                  }
                }
              },
            );
          });
        return () => {
          (H(), $(), Q());
        };
      }
    }, [R, m, E]),
    jsxRuntime.jsx("div", {
      ...p,
      "aria-controls": b.valueControls,
      "aria-orientation": _,
      "aria-valuemax": b.valueMax,
      "aria-valuemin": b.valueMin,
      "aria-valuenow": b.valueNow,
      children: n,
      className: r,
      "data-separator": x,
      "data-testid": m,
      id: m,
      ref: z,
      role: "separator",
      style: { flexBasis: "auto", ...d, flexGrow: 0, flexShrink: 0 },
      tabIndex: 0,
    })
  );
}

ax.displayName = "Separator";

function lx(n) {
  var r,
    u,
    i = "";
  if (typeof n == "string" || typeof n == "number") i += n;
  else if (typeof n == "object")
    if (Array.isArray(n)) {
      var d = n.length;
      for (r = 0; r < d; r++)
        n[r] && (u = lx(n[r])) && (i && (i += " "), (i += u));
    } else for (u in n) n[u] && (i && (i += " "), (i += u));
  return i;
}

function sv() {
  for (var n, r, u = 0, i = "", d = arguments.length; u < d; u++)
    (n = arguments[u]) && (r = lx(n)) && (i && (i += " "), (i += r));
  return i;
}

const ov = (n, r) => {
    const u = new Array(n.length + r.length);
    for (let i = 0; i < n.length; i++) u[i] = n[i];
    for (let i = 0; i < r.length; i++) u[n.length + i] = r[i];
    return u;
  },
  cv = (n, r) => ({ classGroupId: n, validator: r }),
  nx = (n = new Map(), r = null, u) => ({
    nextPart: n,
    validators: r,
    classGroupId: u,
  }),
  ac = "-",
  Wh = [],
  rv = "arbitrary..",
  iv = (n) => {
    const r = dv(n),
      { conflictingClassGroups: u, conflictingClassGroupModifiers: i } = n;
    return {
      getClassGroupId: (m) => {
        if (m.startsWith("[") && m.endsWith("]")) return uv(m);
        const b = m.split(ac),
          h = b[0] === "" && b.length > 1 ? 1 : 0;
        return sx(b, h, r);
      },
      getConflictingClassGroupIds: (m, b) => {
        if (b) {
          const h = i[m],
            x = u[m];
          return h ? (x ? ov(x, h) : h) : x || Wh;
        }
        return u[m] || Wh;
      },
    };
  },
  sx = (n, r, u) => {
    if (n.length - r === 0) return u.classGroupId;
    const d = n[r],
      p = u.nextPart.get(d);
    if (p) {
      const x = sx(n, r + 1, p);
      if (x) return x;
    }
    const m = u.validators;
    if (m === null) return;
    const b = r === 0 ? n.join(ac) : n.slice(r).join(ac),
      h = m.length;
    for (let x = 0; x < h; x++) {
      const y = m[x];
      if (y.validator(b)) return y.classGroupId;
    }
  },
  uv = (n) =>
    n.slice(1, -1).indexOf(":") === -1
      ? void 0
      : (() => {
          const r = n.slice(1, -1),
            u = r.indexOf(":"),
            i = r.slice(0, u);
          return i ? rv + i : void 0;
        })(),
  dv = (n) => {
    const { theme: r, classGroups: u } = n;
    return fv(u, r);
  },
  fv = (n, r) => {
    const u = nx();
    for (const i in n) {
      const d = n[i];
      fu(d, u, i, r);
    }
    return u;
  },
  fu = (n, r, u, i) => {
    const d = n.length;
    for (let p = 0; p < d; p++) {
      const m = n[p];
      pv(m, r, u, i);
    }
  },
  pv = (n, r, u, i) => {
    if (typeof n == "string") {
      hv(n, r, u);
      return;
    }
    if (typeof n == "function") {
      mv(n, r, u, i);
      return;
    }
    xv(n, r, u, i);
  },
  hv = (n, r, u) => {
    const i = n === "" ? r : ox(r, n);
    i.classGroupId = u;
  },
  mv = (n, r, u, i) => {
    if (gv(n)) {
      fu(n(i), r, u, i);
      return;
    }
    (r.validators === null && (r.validators = []), r.validators.push(cv(u, n)));
  },
  xv = (n, r, u, i) => {
    const d = Object.entries(n),
      p = d.length;
    for (let m = 0; m < p; m++) {
      const [b, h] = d[m];
      fu(h, ox(r, b), u, i);
    }
  },
  ox = (n, r) => {
    let u = n;
    const i = r.split(ac),
      d = i.length;
    for (let p = 0; p < d; p++) {
      const m = i[p];
      let b = u.nextPart.get(m);
      (b || ((b = nx()), u.nextPart.set(m, b)), (u = b));
    }
    return u;
  },
  gv = (n) => "isThemeGetter" in n && n.isThemeGetter === !0,
  bv = (n) => {
    if (n < 1) return { get: () => {}, set: () => {} };
    let r = 0,
      u = Object.create(null),
      i = Object.create(null);
    const d = (p, m) => {
      ((u[p] = m), r++, r > n && ((r = 0), (i = u), (u = Object.create(null))));
    };
    return {
      get(p) {
        let m = u[p];
        if (m !== void 0) return m;
        if ((m = i[p]) !== void 0) return (d(p, m), m);
      },
      set(p, m) {
        p in u ? (u[p] = m) : d(p, m);
      },
    };
  },
  Zi = "!",
  Fh = ":",
  yv = [],
  Ih = (n, r, u, i, d) => ({
    modifiers: n,
    hasImportantModifier: r,
    baseClassName: u,
    maybePostfixModifierPosition: i,
    isExternal: d,
  }),
  vv = (n) => {
    const { prefix: r, experimentalParseClassName: u } = n;
    let i = (d) => {
      const p = [];
      let m = 0,
        b = 0,
        h = 0,
        x;
      const y = d.length;
      for (let E = 0; E < y; E++) {
        const _ = d[E];
        if (m === 0 && b === 0) {
          if (_ === Fh) {
            (p.push(d.slice(h, E)), (h = E + 1));
            continue;
          }
          if (_ === "/") {
            x = E;
            continue;
          }
        }
        _ === "[" ? m++ : _ === "]" ? m-- : _ === "(" ? b++ : _ === ")" && b--;
      }
      const j = p.length === 0 ? d : d.slice(h);
      let z = j,
        R = !1;
      j.endsWith(Zi)
        ? ((z = j.slice(0, -1)), (R = !0))
        : j.startsWith(Zi) && ((z = j.slice(1)), (R = !0));
      const N = x && x > h ? x - h : void 0;
      return Ih(p, R, z, N);
    };
    if (r) {
      const d = r + Fh,
        p = i;
      i = (m) =>
        m.startsWith(d) ? p(m.slice(d.length)) : Ih(yv, !1, m, void 0, !0);
    }
    if (u) {
      const d = i;
      i = (p) => u({ className: p, parseClassName: d });
    }
    return i;
  },
  jv = (n) => {
    const r = new Map();
    return (
      n.orderSensitiveModifiers.forEach((u, i) => {
        r.set(u, 1e6 + i);
      }),
      (u) => {
        const i = [];
        let d = [];
        for (let p = 0; p < u.length; p++) {
          const m = u[p],
            b = m[0] === "[",
            h = r.has(m);
          b || h
            ? (d.length > 0 && (d.sort(), i.push(...d), (d = [])), i.push(m))
            : d.push(m);
        }
        return (d.length > 0 && (d.sort(), i.push(...d)), i);
      }
    );
  },
  wv = (n) => ({
    cache: bv(n.cacheSize),
    parseClassName: vv(n),
    sortModifiers: jv(n),
    ...iv(n),
  }),
  Nv = /\s+/,
  Sv = (n, r) => {
    const {
        parseClassName: u,
        getClassGroupId: i,
        getConflictingClassGroupIds: d,
        sortModifiers: p,
      } = r,
      m = [],
      b = n.trim().split(Nv);
    let h = "";
    for (let x = b.length - 1; x >= 0; x -= 1) {
      const y = b[x],
        {
          isExternal: j,
          modifiers: z,
          hasImportantModifier: R,
          baseClassName: N,
          maybePostfixModifierPosition: E,
        } = u(y);
      if (j) {
        h = y + (h.length > 0 ? " " + h : h);
        continue;
      }
      let _ = !!E,
        M = i(_ ? N.substring(0, E) : N);
      if (!M) {
        if (!_) {
          h = y + (h.length > 0 ? " " + h : h);
          continue;
        }
        if (((M = i(N)), !M)) {
          h = y + (h.length > 0 ? " " + h : h);
          continue;
        }
        _ = !1;
      }
      const B = z.length === 0 ? "" : z.length === 1 ? z[0] : p(z).join(":"),
        Q = R ? B + Zi : B,
        H = Q + M;
      if (m.indexOf(H) > -1) continue;
      m.push(H);
      const $ = d(M, _);
      for (let O = 0; O < $.length; ++O) {
        const P = $[O];
        m.push(Q + P);
      }
      h = y + (h.length > 0 ? " " + h : h);
    }
    return h;
  },
  kv = (...n) => {
    let r = 0,
      u,
      i,
      d = "";
    for (; r < n.length; )
      (u = n[r++]) && (i = cx(u)) && (d && (d += " "), (d += i));
    return d;
  },
  cx = (n) => {
    if (typeof n == "string") return n;
    let r,
      u = "";
    for (let i = 0; i < n.length; i++)
      n[i] && (r = cx(n[i])) && (u && (u += " "), (u += r));
    return u;
  },
  zv = (n, ...r) => {
    let u, i, d, p;
    const m = (h) => {
        const x = r.reduce((y, j) => j(y), n());
        return (
          (u = wv(x)),
          (i = u.cache.get),
          (d = u.cache.set),
          (p = b),
          b(h)
        );
      },
      b = (h) => {
        const x = i(h);
        if (x) return x;
        const y = Sv(h, u);
        return (d(h, y), y);
      };
    return ((p = m), (...h) => p(kv(...h)));
  },
  Ev = [],
  Pe = (n) => {
    const r = (u) => u[n] || Ev;
    return ((r.isThemeGetter = !0), r);
  },
  rx = /^\[(?:(\w[\w-]*):)?(.+)\]$/i,
  ix = /^\((?:(\w[\w-]*):)?(.+)\)$/i,
  Cv = /^\d+\/\d+$/,
  _v = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/,
  Dv =
    /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/,
  Mv = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/,
  Av = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/,
  Tv =
    /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/,
  cn = (n) => Cv.test(n),
  ge = (n) => !!n && !Number.isNaN(Number(n)),
  Ka = (n) => !!n && Number.isInteger(Number(n)),
  Gi = (n) => n.endsWith("%") && ge(n.slice(0, -1)),
  xa = (n) => _v.test(n),
  Rv = () => !0,
  Lv = (n) => Dv.test(n) && !Mv.test(n),
  ux = () => !1,
  Ov = (n) => Av.test(n),
  Uv = (n) => Tv.test(n),
  Bv = (n) => !ee(n) && !te(n),
  Hv = (n) => vn(n, px, ux),
  ee = (n) => rx.test(n),
  ml = (n) => vn(n, hx, Lv),
  qi = (n) => vn(n, Vv, ge),
  em = (n) => vn(n, dx, ux),
  Gv = (n) => vn(n, fx, Uv),
  $o = (n) => vn(n, mx, Ov),
  te = (n) => ix.test(n),
  gs = (n) => jn(n, hx),
  qv = (n) => jn(n, Xv),
  tm = (n) => jn(n, dx),
  Qv = (n) => jn(n, px),
  Yv = (n) => jn(n, fx),
  Jo = (n) => jn(n, mx, !0),
  vn = (n, r, u) => {
    const i = rx.exec(n);
    return i ? (i[1] ? r(i[1]) : u(i[2])) : !1;
  },
  jn = (n, r, u = !1) => {
    const i = ix.exec(n);
    return i ? (i[1] ? r(i[1]) : u) : !1;
  },
  dx = (n) => n === "position" || n === "percentage",
  fx = (n) => n === "image" || n === "url",
  px = (n) => n === "length" || n === "size" || n === "bg-size",
  hx = (n) => n === "length",
  Vv = (n) => n === "number",
  Xv = (n) => n === "family-name",
  mx = (n) => n === "shadow",
  Zv = () => {
    const n = Pe("color"),
      r = Pe("font"),
      u = Pe("text"),
      i = Pe("font-weight"),
      d = Pe("tracking"),
      p = Pe("leading"),
      m = Pe("breakpoint"),
      b = Pe("container"),
      h = Pe("spacing"),
      x = Pe("radius"),
      y = Pe("shadow"),
      j = Pe("inset-shadow"),
      z = Pe("text-shadow"),
      R = Pe("drop-shadow"),
      N = Pe("blur"),
      E = Pe("perspective"),
      _ = Pe("aspect"),
      M = Pe("ease"),
      B = Pe("animate"),
      Q = () => [
        "auto",
        "avoid",
        "all",
        "avoid-page",
        "page",
        "left",
        "right",
        "column",
      ],
      H = () => [
        "center",
        "top",
        "bottom",
        "left",
        "right",
        "top-left",
        "left-top",
        "top-right",
        "right-top",
        "bottom-right",
        "right-bottom",
        "bottom-left",
        "left-bottom",
      ],
      $ = () => [...H(), te, ee],
      O = () => ["auto", "hidden", "clip", "visible", "scroll"],
      P = () => ["auto", "contain", "none"],
      G = () => [te, ee, h],
      ne = () => [cn, "full", "auto", ...G()],
      be = () => [Ka, "none", "subgrid", te, ee],
      ke = () => ["auto", { span: ["full", Ka, te, ee] }, Ka, te, ee],
      se = () => [Ka, "auto", te, ee],
      fe = () => ["auto", "min", "max", "fr", te, ee],
      xe = () => [
        "start",
        "end",
        "center",
        "between",
        "around",
        "evenly",
        "stretch",
        "baseline",
        "center-safe",
        "end-safe",
      ],
      Se = () => [
        "start",
        "end",
        "center",
        "stretch",
        "center-safe",
        "end-safe",
      ],
      D = () => ["auto", ...G()],
      K = () => [
        cn,
        "auto",
        "full",
        "dvw",
        "dvh",
        "lvw",
        "lvh",
        "svw",
        "svh",
        "min",
        "max",
        "fit",
        ...G(),
      ],
      Z = () => [n, te, ee],
      W = () => [...H(), tm, em, { position: [te, ee] }],
      ae = () => ["no-repeat", { repeat: ["", "x", "y", "space", "round"] }],
      S = () => ["auto", "cover", "contain", Qv, Hv, { size: [te, ee] }],
      Y = () => [Gi, gs, ml],
      J = () => ["", "none", "full", x, te, ee],
      F = () => ["", ge, gs, ml],
      ue = () => ["solid", "dashed", "dotted", "double"],
      me = () => [
        "normal",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "color-dodge",
        "color-burn",
        "hard-light",
        "soft-light",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
      ],
      re = () => [ge, Gi, tm, em],
      We = () => ["", "none", N, te, ee],
      Oe = () => ["none", ge, te, ee],
      Yt = () => ["none", ge, te, ee],
      va = () => [ge, te, ee],
      ja = () => [cn, "full", ...G()];
    return {
      cacheSize: 500,
      theme: {
        animate: ["spin", "ping", "pulse", "bounce"],
        aspect: ["video"],
        blur: [xa],
        breakpoint: [xa],
        color: [Rv],
        container: [xa],
        "drop-shadow": [xa],
        ease: ["in", "out", "in-out"],
        font: [Bv],
        "font-weight": [
          "thin",
          "extralight",
          "light",
          "normal",
          "medium",
          "semibold",
          "bold",
          "extrabold",
          "black",
        ],
        "inset-shadow": [xa],
        leading: ["none", "tight", "snug", "normal", "relaxed", "loose"],
        perspective: [
          "dramatic",
          "near",
          "normal",
          "midrange",
          "distant",
          "none",
        ],
        radius: [xa],
        shadow: [xa],
        spacing: ["px", ge],
        text: [xa],
        "text-shadow": [xa],
        tracking: ["tighter", "tight", "normal", "wide", "wider", "widest"],
      },
      classGroups: {
        aspect: [{ aspect: ["auto", "square", cn, ee, te, _] }],
        container: ["container"],
        columns: [{ columns: [ge, ee, te, b] }],
        "break-after": [{ "break-after": Q() }],
        "break-before": [{ "break-before": Q() }],
        "break-inside": [
          { "break-inside": ["auto", "avoid", "avoid-page", "avoid-column"] },
        ],
        "box-decoration": [{ "box-decoration": ["slice", "clone"] }],
        box: [{ box: ["border", "content"] }],
        display: [
          "block",
          "inline-block",
          "inline",
          "flex",
          "inline-flex",
          "table",
          "inline-table",
          "table-caption",
          "table-cell",
          "table-column",
          "table-column-group",
          "table-footer-group",
          "table-header-group",
          "table-row-group",
          "table-row",
          "flow-root",
          "grid",
          "inline-grid",
          "contents",
          "list-item",
          "hidden",
        ],
        sr: ["sr-only", "not-sr-only"],
        float: [{ float: ["right", "left", "none", "start", "end"] }],
        clear: [{ clear: ["left", "right", "both", "none", "start", "end"] }],
        isolation: ["isolate", "isolation-auto"],
        "object-fit": [
          { object: ["contain", "cover", "fill", "none", "scale-down"] },
        ],
        "object-position": [{ object: $() }],
        overflow: [{ overflow: O() }],
        "overflow-x": [{ "overflow-x": O() }],
        "overflow-y": [{ "overflow-y": O() }],
        overscroll: [{ overscroll: P() }],
        "overscroll-x": [{ "overscroll-x": P() }],
        "overscroll-y": [{ "overscroll-y": P() }],
        position: ["static", "fixed", "absolute", "relative", "sticky"],
        inset: [{ inset: ne() }],
        "inset-x": [{ "inset-x": ne() }],
        "inset-y": [{ "inset-y": ne() }],
        start: [{ start: ne() }],
        end: [{ end: ne() }],
        top: [{ top: ne() }],
        right: [{ right: ne() }],
        bottom: [{ bottom: ne() }],
        left: [{ left: ne() }],
        visibility: ["visible", "invisible", "collapse"],
        z: [{ z: [Ka, "auto", te, ee] }],
        basis: [{ basis: [cn, "full", "auto", b, ...G()] }],
        "flex-direction": [
          { flex: ["row", "row-reverse", "col", "col-reverse"] },
        ],
        "flex-wrap": [{ flex: ["nowrap", "wrap", "wrap-reverse"] }],
        flex: [{ flex: [ge, cn, "auto", "initial", "none", ee] }],
        grow: [{ grow: ["", ge, te, ee] }],
        shrink: [{ shrink: ["", ge, te, ee] }],
        order: [{ order: [Ka, "first", "last", "none", te, ee] }],
        "grid-cols": [{ "grid-cols": be() }],
        "col-start-end": [{ col: ke() }],
        "col-start": [{ "col-start": se() }],
        "col-end": [{ "col-end": se() }],
        "grid-rows": [{ "grid-rows": be() }],
        "row-start-end": [{ row: ke() }],
        "row-start": [{ "row-start": se() }],
        "row-end": [{ "row-end": se() }],
        "grid-flow": [
          { "grid-flow": ["row", "col", "dense", "row-dense", "col-dense"] },
        ],
        "auto-cols": [{ "auto-cols": fe() }],
        "auto-rows": [{ "auto-rows": fe() }],
        gap: [{ gap: G() }],
        "gap-x": [{ "gap-x": G() }],
        "gap-y": [{ "gap-y": G() }],
        "justify-content": [{ justify: [...xe(), "normal"] }],
        "justify-items": [{ "justify-items": [...Se(), "normal"] }],
        "justify-self": [{ "justify-self": ["auto", ...Se()] }],
        "align-content": [{ content: ["normal", ...xe()] }],
        "align-items": [{ items: [...Se(), { baseline: ["", "last"] }] }],
        "align-self": [{ self: ["auto", ...Se(), { baseline: ["", "last"] }] }],
        "place-content": [{ "place-content": xe() }],
        "place-items": [{ "place-items": [...Se(), "baseline"] }],
        "place-self": [{ "place-self": ["auto", ...Se()] }],
        p: [{ p: G() }],
        px: [{ px: G() }],
        py: [{ py: G() }],
        ps: [{ ps: G() }],
        pe: [{ pe: G() }],
        pt: [{ pt: G() }],
        pr: [{ pr: G() }],
        pb: [{ pb: G() }],
        pl: [{ pl: G() }],
        m: [{ m: D() }],
        mx: [{ mx: D() }],
        my: [{ my: D() }],
        ms: [{ ms: D() }],
        me: [{ me: D() }],
        mt: [{ mt: D() }],
        mr: [{ mr: D() }],
        mb: [{ mb: D() }],
        ml: [{ ml: D() }],
        "space-x": [{ "space-x": G() }],
        "space-x-reverse": ["space-x-reverse"],
        "space-y": [{ "space-y": G() }],
        "space-y-reverse": ["space-y-reverse"],
        size: [{ size: K() }],
        w: [{ w: [b, "screen", ...K()] }],
        "min-w": [{ "min-w": [b, "screen", "none", ...K()] }],
        "max-w": [
          { "max-w": [b, "screen", "none", "prose", { screen: [m] }, ...K()] },
        ],
        h: [{ h: ["screen", "lh", ...K()] }],
        "min-h": [{ "min-h": ["screen", "lh", "none", ...K()] }],
        "max-h": [{ "max-h": ["screen", "lh", ...K()] }],
        "font-size": [{ text: ["base", u, gs, ml] }],
        "font-smoothing": ["antialiased", "subpixel-antialiased"],
        "font-style": ["italic", "not-italic"],
        "font-weight": [{ font: [i, te, qi] }],
        "font-stretch": [
          {
            "font-stretch": [
              "ultra-condensed",
              "extra-condensed",
              "condensed",
              "semi-condensed",
              "normal",
              "semi-expanded",
              "expanded",
              "extra-expanded",
              "ultra-expanded",
              Gi,
              ee,
            ],
          },
        ],
        "font-family": [{ font: [qv, ee, r] }],
        "fvn-normal": ["normal-nums"],
        "fvn-ordinal": ["ordinal"],
        "fvn-slashed-zero": ["slashed-zero"],
        "fvn-figure": ["lining-nums", "oldstyle-nums"],
        "fvn-spacing": ["proportional-nums", "tabular-nums"],
        "fvn-fraction": ["diagonal-fractions", "stacked-fractions"],
        tracking: [{ tracking: [d, te, ee] }],
        "line-clamp": [{ "line-clamp": [ge, "none", te, qi] }],
        leading: [{ leading: [p, ...G()] }],
        "list-image": [{ "list-image": ["none", te, ee] }],
        "list-style-position": [{ list: ["inside", "outside"] }],
        "list-style-type": [{ list: ["disc", "decimal", "none", te, ee] }],
        "text-alignment": [
          { text: ["left", "center", "right", "justify", "start", "end"] },
        ],
        "placeholder-color": [{ placeholder: Z() }],
        "text-color": [{ text: Z() }],
        "text-decoration": [
          "underline",
          "overline",
          "line-through",
          "no-underline",
        ],
        "text-decoration-style": [{ decoration: [...ue(), "wavy"] }],
        "text-decoration-thickness": [
          { decoration: [ge, "from-font", "auto", te, ml] },
        ],
        "text-decoration-color": [{ decoration: Z() }],
        "underline-offset": [{ "underline-offset": [ge, "auto", te, ee] }],
        "text-transform": [
          "uppercase",
          "lowercase",
          "capitalize",
          "normal-case",
        ],
        "text-overflow": ["truncate", "text-ellipsis", "text-clip"],
        "text-wrap": [{ text: ["wrap", "nowrap", "balance", "pretty"] }],
        indent: [{ indent: G() }],
        "vertical-align": [
          {
            align: [
              "baseline",
              "top",
              "middle",
              "bottom",
              "text-top",
              "text-bottom",
              "sub",
              "super",
              te,
              ee,
            ],
          },
        ],
        whitespace: [
          {
            whitespace: [
              "normal",
              "nowrap",
              "pre",
              "pre-line",
              "pre-wrap",
              "break-spaces",
            ],
          },
        ],
        break: [{ break: ["normal", "words", "all", "keep"] }],
        wrap: [{ wrap: ["break-word", "anywhere", "normal"] }],
        hyphens: [{ hyphens: ["none", "manual", "auto"] }],
        content: [{ content: ["none", te, ee] }],
        "bg-attachment": [{ bg: ["fixed", "local", "scroll"] }],
        "bg-clip": [{ "bg-clip": ["border", "padding", "content", "text"] }],
        "bg-origin": [{ "bg-origin": ["border", "padding", "content"] }],
        "bg-position": [{ bg: W() }],
        "bg-repeat": [{ bg: ae() }],
        "bg-size": [{ bg: S() }],
        "bg-image": [
          {
            bg: [
              "none",
              {
                linear: [
                  { to: ["t", "tr", "r", "br", "b", "bl", "l", "tl"] },
                  Ka,
                  te,
                  ee,
                ],
                radial: ["", te, ee],
                conic: [Ka, te, ee],
              },
              Yv,
              Gv,
            ],
          },
        ],
        "bg-color": [{ bg: Z() }],
        "gradient-from-pos": [{ from: Y() }],
        "gradient-via-pos": [{ via: Y() }],
        "gradient-to-pos": [{ to: Y() }],
        "gradient-from": [{ from: Z() }],
        "gradient-via": [{ via: Z() }],
        "gradient-to": [{ to: Z() }],
        rounded: [{ rounded: J() }],
        "rounded-s": [{ "rounded-s": J() }],
        "rounded-e": [{ "rounded-e": J() }],
        "rounded-t": [{ "rounded-t": J() }],
        "rounded-r": [{ "rounded-r": J() }],
        "rounded-b": [{ "rounded-b": J() }],
        "rounded-l": [{ "rounded-l": J() }],
        "rounded-ss": [{ "rounded-ss": J() }],
        "rounded-se": [{ "rounded-se": J() }],
        "rounded-ee": [{ "rounded-ee": J() }],
        "rounded-es": [{ "rounded-es": J() }],
        "rounded-tl": [{ "rounded-tl": J() }],
        "rounded-tr": [{ "rounded-tr": J() }],
        "rounded-br": [{ "rounded-br": J() }],
        "rounded-bl": [{ "rounded-bl": J() }],
        "border-w": [{ border: F() }],
        "border-w-x": [{ "border-x": F() }],
        "border-w-y": [{ "border-y": F() }],
        "border-w-s": [{ "border-s": F() }],
        "border-w-e": [{ "border-e": F() }],
        "border-w-t": [{ "border-t": F() }],
        "border-w-r": [{ "border-r": F() }],
        "border-w-b": [{ "border-b": F() }],
        "border-w-l": [{ "border-l": F() }],
        "divide-x": [{ "divide-x": F() }],
        "divide-x-reverse": ["divide-x-reverse"],
        "divide-y": [{ "divide-y": F() }],
        "divide-y-reverse": ["divide-y-reverse"],
        "border-style": [{ border: [...ue(), "hidden", "none"] }],
        "divide-style": [{ divide: [...ue(), "hidden", "none"] }],
        "border-color": [{ border: Z() }],
        "border-color-x": [{ "border-x": Z() }],
        "border-color-y": [{ "border-y": Z() }],
        "border-color-s": [{ "border-s": Z() }],
        "border-color-e": [{ "border-e": Z() }],
        "border-color-t": [{ "border-t": Z() }],
        "border-color-r": [{ "border-r": Z() }],
        "border-color-b": [{ "border-b": Z() }],
        "border-color-l": [{ "border-l": Z() }],
        "divide-color": [{ divide: Z() }],
        "outline-style": [{ outline: [...ue(), "none", "hidden"] }],
        "outline-offset": [{ "outline-offset": [ge, te, ee] }],
        "outline-w": [{ outline: ["", ge, gs, ml] }],
        "outline-color": [{ outline: Z() }],
        shadow: [{ shadow: ["", "none", y, Jo, $o] }],
        "shadow-color": [{ shadow: Z() }],
        "inset-shadow": [{ "inset-shadow": ["none", j, Jo, $o] }],
        "inset-shadow-color": [{ "inset-shadow": Z() }],
        "ring-w": [{ ring: F() }],
        "ring-w-inset": ["ring-inset"],
        "ring-color": [{ ring: Z() }],
        "ring-offset-w": [{ "ring-offset": [ge, ml] }],
        "ring-offset-color": [{ "ring-offset": Z() }],
        "inset-ring-w": [{ "inset-ring": F() }],
        "inset-ring-color": [{ "inset-ring": Z() }],
        "text-shadow": [{ "text-shadow": ["none", z, Jo, $o] }],
        "text-shadow-color": [{ "text-shadow": Z() }],
        opacity: [{ opacity: [ge, te, ee] }],
        "mix-blend": [
          { "mix-blend": [...me(), "plus-darker", "plus-lighter"] },
        ],
        "bg-blend": [{ "bg-blend": me() }],
        "mask-clip": [
          {
            "mask-clip": [
              "border",
              "padding",
              "content",
              "fill",
              "stroke",
              "view",
            ],
          },
          "mask-no-clip",
        ],
        "mask-composite": [
          { mask: ["add", "subtract", "intersect", "exclude"] },
        ],
        "mask-image-linear-pos": [{ "mask-linear": [ge] }],
        "mask-image-linear-from-pos": [{ "mask-linear-from": re() }],
        "mask-image-linear-to-pos": [{ "mask-linear-to": re() }],
        "mask-image-linear-from-color": [{ "mask-linear-from": Z() }],
        "mask-image-linear-to-color": [{ "mask-linear-to": Z() }],
        "mask-image-t-from-pos": [{ "mask-t-from": re() }],
        "mask-image-t-to-pos": [{ "mask-t-to": re() }],
        "mask-image-t-from-color": [{ "mask-t-from": Z() }],
        "mask-image-t-to-color": [{ "mask-t-to": Z() }],
        "mask-image-r-from-pos": [{ "mask-r-from": re() }],
        "mask-image-r-to-pos": [{ "mask-r-to": re() }],
        "mask-image-r-from-color": [{ "mask-r-from": Z() }],
        "mask-image-r-to-color": [{ "mask-r-to": Z() }],
        "mask-image-b-from-pos": [{ "mask-b-from": re() }],
        "mask-image-b-to-pos": [{ "mask-b-to": re() }],
        "mask-image-b-from-color": [{ "mask-b-from": Z() }],
        "mask-image-b-to-color": [{ "mask-b-to": Z() }],
        "mask-image-l-from-pos": [{ "mask-l-from": re() }],
        "mask-image-l-to-pos": [{ "mask-l-to": re() }],
        "mask-image-l-from-color": [{ "mask-l-from": Z() }],
        "mask-image-l-to-color": [{ "mask-l-to": Z() }],
        "mask-image-x-from-pos": [{ "mask-x-from": re() }],
        "mask-image-x-to-pos": [{ "mask-x-to": re() }],
        "mask-image-x-from-color": [{ "mask-x-from": Z() }],
        "mask-image-x-to-color": [{ "mask-x-to": Z() }],
        "mask-image-y-from-pos": [{ "mask-y-from": re() }],
        "mask-image-y-to-pos": [{ "mask-y-to": re() }],
        "mask-image-y-from-color": [{ "mask-y-from": Z() }],
        "mask-image-y-to-color": [{ "mask-y-to": Z() }],
        "mask-image-radial": [{ "mask-radial": [te, ee] }],
        "mask-image-radial-from-pos": [{ "mask-radial-from": re() }],
        "mask-image-radial-to-pos": [{ "mask-radial-to": re() }],
        "mask-image-radial-from-color": [{ "mask-radial-from": Z() }],
        "mask-image-radial-to-color": [{ "mask-radial-to": Z() }],
        "mask-image-radial-shape": [{ "mask-radial": ["circle", "ellipse"] }],
        "mask-image-radial-size": [
          {
            "mask-radial": [
              { closest: ["side", "corner"], farthest: ["side", "corner"] },
            ],
          },
        ],
        "mask-image-radial-pos": [{ "mask-radial-at": H() }],
        "mask-image-conic-pos": [{ "mask-conic": [ge] }],
        "mask-image-conic-from-pos": [{ "mask-conic-from": re() }],
        "mask-image-conic-to-pos": [{ "mask-conic-to": re() }],
        "mask-image-conic-from-color": [{ "mask-conic-from": Z() }],
        "mask-image-conic-to-color": [{ "mask-conic-to": Z() }],
        "mask-mode": [{ mask: ["alpha", "luminance", "match"] }],
        "mask-origin": [
          {
            "mask-origin": [
              "border",
              "padding",
              "content",
              "fill",
              "stroke",
              "view",
            ],
          },
        ],
        "mask-position": [{ mask: W() }],
        "mask-repeat": [{ mask: ae() }],
        "mask-size": [{ mask: S() }],
        "mask-type": [{ "mask-type": ["alpha", "luminance"] }],
        "mask-image": [{ mask: ["none", te, ee] }],
        filter: [{ filter: ["", "none", te, ee] }],
        blur: [{ blur: We() }],
        brightness: [{ brightness: [ge, te, ee] }],
        contrast: [{ contrast: [ge, te, ee] }],
        "drop-shadow": [{ "drop-shadow": ["", "none", R, Jo, $o] }],
        "drop-shadow-color": [{ "drop-shadow": Z() }],
        grayscale: [{ grayscale: ["", ge, te, ee] }],
        "hue-rotate": [{ "hue-rotate": [ge, te, ee] }],
        invert: [{ invert: ["", ge, te, ee] }],
        saturate: [{ saturate: [ge, te, ee] }],
        sepia: [{ sepia: ["", ge, te, ee] }],
        "backdrop-filter": [{ "backdrop-filter": ["", "none", te, ee] }],
        "backdrop-blur": [{ "backdrop-blur": We() }],
        "backdrop-brightness": [{ "backdrop-brightness": [ge, te, ee] }],
        "backdrop-contrast": [{ "backdrop-contrast": [ge, te, ee] }],
        "backdrop-grayscale": [{ "backdrop-grayscale": ["", ge, te, ee] }],
        "backdrop-hue-rotate": [{ "backdrop-hue-rotate": [ge, te, ee] }],
        "backdrop-invert": [{ "backdrop-invert": ["", ge, te, ee] }],
        "backdrop-opacity": [{ "backdrop-opacity": [ge, te, ee] }],
        "backdrop-saturate": [{ "backdrop-saturate": [ge, te, ee] }],
        "backdrop-sepia": [{ "backdrop-sepia": ["", ge, te, ee] }],
        "border-collapse": [{ border: ["collapse", "separate"] }],
        "border-spacing": [{ "border-spacing": G() }],
        "border-spacing-x": [{ "border-spacing-x": G() }],
        "border-spacing-y": [{ "border-spacing-y": G() }],
        "table-layout": [{ table: ["auto", "fixed"] }],
        caption: [{ caption: ["top", "bottom"] }],
        transition: [
          {
            transition: [
              "",
              "all",
              "colors",
              "opacity",
              "shadow",
              "transform",
              "none",
              te,
              ee,
            ],
          },
        ],
        "transition-behavior": [{ transition: ["normal", "discrete"] }],
        duration: [{ duration: [ge, "initial", te, ee] }],
        ease: [{ ease: ["linear", "initial", M, te, ee] }],
        delay: [{ delay: [ge, te, ee] }],
        animate: [{ animate: ["none", B, te, ee] }],
        backface: [{ backface: ["hidden", "visible"] }],
        perspective: [{ perspective: [E, te, ee] }],
        "perspective-origin": [{ "perspective-origin": $() }],
        rotate: [{ rotate: Oe() }],
        "rotate-x": [{ "rotate-x": Oe() }],
        "rotate-y": [{ "rotate-y": Oe() }],
        "rotate-z": [{ "rotate-z": Oe() }],
        scale: [{ scale: Yt() }],
        "scale-x": [{ "scale-x": Yt() }],
        "scale-y": [{ "scale-y": Yt() }],
        "scale-z": [{ "scale-z": Yt() }],
        "scale-3d": ["scale-3d"],
        skew: [{ skew: va() }],
        "skew-x": [{ "skew-x": va() }],
        "skew-y": [{ "skew-y": va() }],
        transform: [{ transform: [te, ee, "", "none", "gpu", "cpu"] }],
        "transform-origin": [{ origin: $() }],
        "transform-style": [{ transform: ["3d", "flat"] }],
        translate: [{ translate: ja() }],
        "translate-x": [{ "translate-x": ja() }],
        "translate-y": [{ "translate-y": ja() }],
        "translate-z": [{ "translate-z": ja() }],
        "translate-none": ["translate-none"],
        accent: [{ accent: Z() }],
        appearance: [{ appearance: ["none", "auto"] }],
        "caret-color": [{ caret: Z() }],
        "color-scheme": [
          {
            scheme: [
              "normal",
              "dark",
              "light",
              "light-dark",
              "only-dark",
              "only-light",
            ],
          },
        ],
        cursor: [
          {
            cursor: [
              "auto",
              "default",
              "pointer",
              "wait",
              "text",
              "move",
              "help",
              "not-allowed",
              "none",
              "context-menu",
              "progress",
              "cell",
              "crosshair",
              "vertical-text",
              "alias",
              "copy",
              "no-drop",
              "grab",
              "grabbing",
              "all-scroll",
              "col-resize",
              "row-resize",
              "n-resize",
              "e-resize",
              "s-resize",
              "w-resize",
              "ne-resize",
              "nw-resize",
              "se-resize",
              "sw-resize",
              "ew-resize",
              "ns-resize",
              "nesw-resize",
              "nwse-resize",
              "zoom-in",
              "zoom-out",
              te,
              ee,
            ],
          },
        ],
        "field-sizing": [{ "field-sizing": ["fixed", "content"] }],
        "pointer-events": [{ "pointer-events": ["auto", "none"] }],
        resize: [{ resize: ["none", "", "y", "x"] }],
        "scroll-behavior": [{ scroll: ["auto", "smooth"] }],
        "scroll-m": [{ "scroll-m": G() }],
        "scroll-mx": [{ "scroll-mx": G() }],
        "scroll-my": [{ "scroll-my": G() }],
        "scroll-ms": [{ "scroll-ms": G() }],
        "scroll-me": [{ "scroll-me": G() }],
        "scroll-mt": [{ "scroll-mt": G() }],
        "scroll-mr": [{ "scroll-mr": G() }],
        "scroll-mb": [{ "scroll-mb": G() }],
        "scroll-ml": [{ "scroll-ml": G() }],
        "scroll-p": [{ "scroll-p": G() }],
        "scroll-px": [{ "scroll-px": G() }],
        "scroll-py": [{ "scroll-py": G() }],
        "scroll-ps": [{ "scroll-ps": G() }],
        "scroll-pe": [{ "scroll-pe": G() }],
        "scroll-pt": [{ "scroll-pt": G() }],
        "scroll-pr": [{ "scroll-pr": G() }],
        "scroll-pb": [{ "scroll-pb": G() }],
        "scroll-pl": [{ "scroll-pl": G() }],
        "snap-align": [{ snap: ["start", "end", "center", "align-none"] }],
        "snap-stop": [{ snap: ["normal", "always"] }],
        "snap-type": [{ snap: ["none", "x", "y", "both"] }],
        "snap-strictness": [{ snap: ["mandatory", "proximity"] }],
        touch: [{ touch: ["auto", "none", "manipulation"] }],
        "touch-x": [{ "touch-pan": ["x", "left", "right"] }],
        "touch-y": [{ "touch-pan": ["y", "up", "down"] }],
        "touch-pz": ["touch-pinch-zoom"],
        select: [{ select: ["none", "text", "all", "auto"] }],
        "will-change": [
          {
            "will-change": ["auto", "scroll", "contents", "transform", te, ee],
          },
        ],
        fill: [{ fill: ["none", ...Z()] }],
        "stroke-w": [{ stroke: [ge, gs, ml, qi] }],
        stroke: [{ stroke: ["none", ...Z()] }],
        "forced-color-adjust": [{ "forced-color-adjust": ["auto", "none"] }],
      },
      conflictingClassGroups: {
        overflow: ["overflow-x", "overflow-y"],
        overscroll: ["overscroll-x", "overscroll-y"],
        inset: [
          "inset-x",
          "inset-y",
          "start",
          "end",
          "top",
          "right",
          "bottom",
          "left",
        ],
        "inset-x": ["right", "left"],
        "inset-y": ["top", "bottom"],
        flex: ["basis", "grow", "shrink"],
        gap: ["gap-x", "gap-y"],
        p: ["px", "py", "ps", "pe", "pt", "pr", "pb", "pl"],
        px: ["pr", "pl"],
        py: ["pt", "pb"],
        m: ["mx", "my", "ms", "me", "mt", "mr", "mb", "ml"],
        mx: ["mr", "ml"],
        my: ["mt", "mb"],
        size: ["w", "h"],
        "font-size": ["leading"],
        "fvn-normal": [
          "fvn-ordinal",
          "fvn-slashed-zero",
          "fvn-figure",
          "fvn-spacing",
          "fvn-fraction",
        ],
        "fvn-ordinal": ["fvn-normal"],
        "fvn-slashed-zero": ["fvn-normal"],
        "fvn-figure": ["fvn-normal"],
        "fvn-spacing": ["fvn-normal"],
        "fvn-fraction": ["fvn-normal"],
        "line-clamp": ["display", "overflow"],
        rounded: [
          "rounded-s",
          "rounded-e",
          "rounded-t",
          "rounded-r",
          "rounded-b",
          "rounded-l",
          "rounded-ss",
          "rounded-se",
          "rounded-ee",
          "rounded-es",
          "rounded-tl",
          "rounded-tr",
          "rounded-br",
          "rounded-bl",
        ],
        "rounded-s": ["rounded-ss", "rounded-es"],
        "rounded-e": ["rounded-se", "rounded-ee"],
        "rounded-t": ["rounded-tl", "rounded-tr"],
        "rounded-r": ["rounded-tr", "rounded-br"],
        "rounded-b": ["rounded-br", "rounded-bl"],
        "rounded-l": ["rounded-tl", "rounded-bl"],
        "border-spacing": ["border-spacing-x", "border-spacing-y"],
        "border-w": [
          "border-w-x",
          "border-w-y",
          "border-w-s",
          "border-w-e",
          "border-w-t",
          "border-w-r",
          "border-w-b",
          "border-w-l",
        ],
        "border-w-x": ["border-w-r", "border-w-l"],
        "border-w-y": ["border-w-t", "border-w-b"],
        "border-color": [
          "border-color-x",
          "border-color-y",
          "border-color-s",
          "border-color-e",
          "border-color-t",
          "border-color-r",
          "border-color-b",
          "border-color-l",
        ],
        "border-color-x": ["border-color-r", "border-color-l"],
        "border-color-y": ["border-color-t", "border-color-b"],
        translate: ["translate-x", "translate-y", "translate-none"],
        "translate-none": [
          "translate",
          "translate-x",
          "translate-y",
          "translate-z",
        ],
        "scroll-m": [
          "scroll-mx",
          "scroll-my",
          "scroll-ms",
          "scroll-me",
          "scroll-mt",
          "scroll-mr",
          "scroll-mb",
          "scroll-ml",
        ],
        "scroll-mx": ["scroll-mr", "scroll-ml"],
        "scroll-my": ["scroll-mt", "scroll-mb"],
        "scroll-p": [
          "scroll-px",
          "scroll-py",
          "scroll-ps",
          "scroll-pe",
          "scroll-pt",
          "scroll-pr",
          "scroll-pb",
          "scroll-pl",
        ],
        "scroll-px": ["scroll-pr", "scroll-pl"],
        "scroll-py": ["scroll-pt", "scroll-pb"],
        touch: ["touch-x", "touch-y", "touch-pz"],
        "touch-x": ["touch"],
        "touch-y": ["touch"],
        "touch-pz": ["touch"],
      },
      conflictingClassGroupModifiers: { "font-size": ["leading"] },
      orderSensitiveModifiers: [
        "*",
        "**",
        "after",
        "backdrop",
        "before",
        "details-content",
        "file",
        "first-letter",
        "first-line",
        "marker",
        "placeholder",
        "selection",
      ],
    };
  },
  Kv = zv(Zv);

function xx(...n) {
  return Kv(sv(n));
}

function gx({ className: n, ...r }) {
  const [stacked, setStacked] = React.useState(() => window.matchMedia("(max-width: 767px)").matches);
  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setStacked(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return jsxRuntime.jsx(ex, {
    "code-path": "src\\components\\ui\\resizable.tsx:12:5",
    "data-slot": "resizable-panel-group",
    className: xx(
      "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
      n,
    ),
    ...r,
    orientation: stacked ? "vertical" : r.orientation,
  });
}

function lc({ ...n }) {
  return jsxRuntime.jsx(tx, {
    "code-path": "src\\components\\ui\\resizable.tsx:26:10",
    "data-slot": "resizable-panel",
    ...n,
  });
}

function bx({ withHandle: n, className: r, ...u }) {
  return jsxRuntime.jsx(ax, {
    "code-path": "src\\components\\ui\\resizable.tsx:37:5",
    "data-slot": "resizable-handle",
    className: xx(
      "bg-border focus-visible:ring-ring relative flex w-px max-md:h-2 max-md:w-full items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2 [&[data-panel-group-direction=vertical]>div]:rotate-90",
      r,
    ),
    ...u,
    children:
      n &&
      jsxRuntime.jsx("div", {
        "code-path": "src\\components\\ui\\resizable.tsx:46:9",
        className:
          "bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border",
        children: jsxRuntime.jsx(O2, {
          "code-path": "src\\components\\ui\\resizable.tsx:47:11",
          className: "size-2.5",
        }),
      }),
  });
}

const yx = "zhixun-lecture-bookmarks";

function pu() {
  try {
    const n = JSON.parse(localStorage.getItem(yx) ?? "[]");
    return Array.isArray(n) ? n : [];
  } catch {
    return [];
  }
}

function hu(n) {
  localStorage.setItem(yx, JSON.stringify(n));
  persistState({ bookmarks: n });
}

function am() {
  const n = window;
  return n.SpeechRecognition ?? n.webkitSpeechRecognition ?? null;
}

function mu(n) {
  const r = React.useRef(n),
    u = React.useRef(null),
    [i, d] = React.useState(!1),
    p = typeof window < "u" && am() !== null;
  return (
    React.useEffect(() => {
      r.current = n;
    }, [n]),
    React.useEffect(
      () => () => {
        u.current?.abort();
      },
      [],
    ),
    {
      listening: i,
      supported: p,
      toggleListening: () => {
        if (i) {
          (u.current?.stop(), d(!1));
          return;
        }
        const b = am();
        if (!b) return;
        const h = new b();
        ((h.lang = "zh-CN"),
          (h.continuous = !1),
          (h.interimResults = !1),
          (h.onresult = (x) => {
            const y = x.results[0]?.[0]?.transcript?.trim();
            y && r.current(y);
          }),
          (h.onend = () => d(!1)),
          (h.onerror = () => d(!1)),
          (u.current = h),
          d(!0),
          h.start());
      },
    }
  );
}

function $v(n, r) {
  return [
    {
      question: `学习“${r}”时，最合理的第一步是什么？`,
      options: [
        "直接背诵所有结论",
        "先明确它解决的问题与使用场景",
        "忽略限制条件，只看最终答案",
        "只练习难度最高的题目",
      ],
      correct: 1,
      theoryTitle: "从问题出发建立理解",
      explanation: `理解${r}时，首先要明确它解决了什么问题、输入和输出分别是什么。建立场景之后，后续概念才不再是孤立的定义。直接背诵可能形成短期记忆，却很难迁移到新的问题中。`,
    },
    {
      question: `分析${n.name}中的复杂过程时，哪种方法最有效？`,
      options: [
        "把所有步骤视为一个黑盒",
        "只关注最终结果是否正确",
        "拆分为输入、状态变化与输出逐步验证",
        "始终选择步骤最多的方案",
      ],
      correct: 2,
      theoryTitle: "拆解过程与追踪状态",
      explanation:
        "把复杂过程拆成输入、状态变化和输出，可以清晰追踪每一步的数据与约束。这种方法既能定位错误，也能帮助我们解释为什么最终会得到特定结果。",
    },
    {
      question: "面对多个都能解决问题的方案，应该优先依据什么作出选择？",
      options: [
        "结合正确性、资源成本和实际场景综合权衡",
        "选择名字最长的方案",
        "只考虑运行速度，忽略其他条件",
        "随机选择以节约分析时间",
      ],
      correct: 0,
      theoryTitle: "场景决定方案取舍",
      explanation:
        "工程问题通常没有脱离场景的唯一最优解。正确性是基础，同时还要比较时间、空间、可维护性和业务限制，最终选择最符合当前目标的方案。",
    },
    {
      question: `怎样判断自己真正掌握了“${r}”？`,
      options: [
        "看过一遍讲义即可",
        "能够复述定义但不能举例",
        "记住所有术语的英文写法",
        "能解释目标、完整过程并在新场景中应用",
      ],
      correct: 3,
      theoryTitle: "建立可迁移的知识框架",
      explanation: `真正掌握${r}，意味着能用自己的语言说明它解决的问题、解释关键过程，并在条件改变时作出合理选择。能够迁移到新场景，是比记忆定义更可靠的掌握标志。`,
    },
  ];
}

function Jv({ onContinue: n, onExit: r }) {
  return jsxRuntime.jsx("div", {
    "code-path": "src\\pages\\QuizFlow.tsx:65:5",
    className:
      "fixed inset-0 z-[120] flex items-center justify-center bg-[#32343c]/45 px-5 backdrop-blur-[1px]",
    children: jsxRuntime.jsxs("section", {
      "code-path": "src\\pages\\QuizFlow.tsx:66:7",
      className:
        "relative mt-10 w-full max-w-[480px] rounded-[22px] bg-white px-4 pb-5 pt-[78px] text-center shadow-[0_28px_80px_rgba(14,13,20,0.28)]",
      children: [
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\QuizFlow.tsx:67:9",
          className:
            "absolute left-1/2 top-0 flex h-[116px] w-[116px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#f5f3fa] ring-[10px] ring-white",
          children: [
            jsxRuntime.jsx(cc, {
              "code-path": "src\\pages\\QuizFlow.tsx:68:11",
              className: "h-12 w-12 fill-[#7652ed] text-[#2f245d]",
            }),
            jsxRuntime.jsx(hn, {
              "code-path": "src\\pages\\QuizFlow.tsx:69:11",
              className:
                "absolute right-6 top-7 h-5 w-5 fill-[#ffd83d] text-[#ffd83d]",
            }),
          ],
        }),
        jsxRuntime.jsx("h2", {
          "code-path": "src\\pages\\QuizFlow.tsx:71:9",
          className: "text-2xl font-black text-[#111318]",
          children: "就停在那儿！",
        }),
        jsxRuntime.jsx("p", {
          "code-path": "src\\pages\\QuizFlow.tsx:72:9",
          className: "mt-3 text-sm font-semibold text-[#858995]",
          children:
            "你做得非常棒。如果现在放弃，本次尚未提交的答题进度将不会保存。",
        }),
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\QuizFlow.tsx:73:9",
          className: "mt-7 border-t border-black/[0.07] pt-4",
          children: [
            jsxRuntime.jsx("button", {
              "code-path": "src\\pages\\QuizFlow.tsx:74:11",
              type: "button",
              onClick: n,
              className:
                "w-full rounded-xl bg-[#5f38ef] py-3.5 text-base font-black text-white shadow-[0_7px_20px_rgba(95,56,239,0.22)]",
              children: "继续答题",
            }),
            jsxRuntime.jsx("button", {
              "code-path": "src\\pages\\QuizFlow.tsx:75:11",
              type: "button",
              onClick: r,
              className:
                "mt-2 w-full rounded-xl py-3 text-base font-extrabold text-[#df3434] hover:bg-[#fff1f1]",
              children: "结束测试",
            }),
          ],
        }),
      ],
    }),
  });
}

function QuizFlow({ course: n, lessonTitle: r, lessonIndex: lessonNumber, onExit: u, initialQuestionIndex = 0, focusQuestionId = "" }) {
  const resolvedIndex =
      lessonNumber ??
      $t.find((course) => course.id === n.id)?.chapters.findIndex((chapter) => chapter.title === r) ??
      0,
    remote = useLesson(n, resolvedIndex),
    i = React.useMemo(
      () => (remote.lesson?.resources?.bank?.questions ?? remote.lesson?.questions ?? []).map((question) => ({ ...question, question: question.question || question.stem, theoryTitle: question.theoryTitle || "本题解析" })),
      [remote.lesson],
    ),
    [d, p] = React.useState(() => {
      const requested = focusQuestionId
        ? i.findIndex((question) => question.id === focusQuestionId)
        : -1;
      if (requested >= 0) return requested;
      return Math.min(Math.max(Number.isInteger(initialQuestionIndex) ? initialQuestionIndex : 0, 0), Math.max(i.length - 1, 0));
    }),
    [m, b] = React.useState(null),
    [h, x] = React.useState("answering"),
    [y, j] = React.useState([]),
    [z, R] = React.useState(!1),
    [N, E] = React.useState(!1),
    [_, M] = React.useState(!1),
    [B, Q] = React.useState(""),
    [H, $] = React.useState([]),
    [luminPending, setLuminPending] = React.useState(false),
    [luminError, setLuminError] = React.useState(""),
    [O, P] = React.useState(0),
    answersRef = React.useRef([]),
    attemptRef = React.useRef(null),
    submittedRef = React.useRef(false),
    [answerState, setAnswerState] = React.useState({ pending: false, error: "" }),
    [quizSave, setQuizSave] = React.useState({ pending: false, error: "", result: null }),
    G = i[d] ?? {},
    ne = m === G.correct,
    be =
      h === "complete"
        ? 100
        : ((d + (h === "answering" ? 0 : 1)) / i.length) * 100;
  React.useEffect(() => {
    if (h === "complete") return;
    const D = window.setInterval(() => P((K) => K + 1), 1e3);
    return () => window.clearInterval(D);
  }, [h]);
  const ke = async () => {
      if (m === null || h !== "answering" || answerState.pending) return;
      if (!G.id) { setAnswerState({ pending: false, error: "题目暂不可用，请返回课程后重新打开。" }); return; }
      setAnswerState({ pending: true, error: "" });
      let D = false;
      if (G.id) {
        try {
          const result = await api(
            `/courses/${encodeURIComponent(n.id)}/lessons/${resolvedIndex}/answer`,
            "POST",
            { questionId: G.id, choice: m },
          );
          G.correct = result.correctIndex;
          G.explanation = result.explanation;
          D = result.correct;
        } catch (error) {
          setAnswerState({ pending: false, error: error.message });
          return;
        }
      }
      setAnswerState({ pending: false, error: "" });
      answersRef.current = [...answersRef.current, { questionId: G.id, choice: m }];
      (j((K) => [...K, D]), x(D ? "correct" : "wrong"));
    },
    se = () => {
      if (d >= i.length - 1) {
        x("complete");
        return;
      }
      (p((D) => D + 1), b(null), x("answering"), E(!1), M(!1), $([]));
    },
    fe = () => {
      const D = `quiz-${n.id}-${d}`,
        K = pu(),
        Z = K.some((ae) => ae.id === D),
        W = Z
          ? K.filter((ae) => ae.id !== D)
          : [
              {
                id: D,
                courseId: n.id,
                courseName: n.name,
                lessonIndex: resolvedIndex,
                lessonTitle: r,
                questionId: G.id,
                questionIndex: d,
                question: G.question,
                options: G.options,
                selectedIndex: m,
                correctIndex: G.correct,
                correct: ne,
                heading: G.theoryTitle,
                text: G.explanation,
                resourceKind: "bank",
                resourceVersion: remote.lesson?.resourceVersions?.bank,
                sourceDocId: remote.lesson?.sources?.[0]?.id || "",
                savedAt: new Date().toISOString(),
              },
              ...K,
            ];
      (hu(W), E(!Z));
    },
    xe = async () => {
      const D = B.trim();
      if (!D || luminPending) return;
      const selected = m === null ? "未作答" : `${m + 1}. ${G.options?.[m] || ""}`;
      const correct = G.correct === undefined ? "未知" : `${G.correct + 1}. ${G.options?.[G.correct] || ""}`;
      const quote = [
        `题目：${G.question || ""}`,
        `选项：${(G.options || []).map((option, index) => `${index + 1}. ${option}`).join("；")}`,
        `我的选择：${selected}`,
        `正确答案：${correct}`,
        `判定：${ne ? "回答正确" : "回答错误"}`,
        `解析：${G.explanation || ""}`,
      ].join("\n");
      $((K) => [...K, `你：${D}`]);
      Q("");
      setLuminError("");
      setLuminPending(true);
      try {
        const result = await askTutor({
          message: D,
          quote,
          courseId: n.id,
          lessonIndex: resolvedIndex,
          lessonTitle: r,
          conversationId: `lesson:${n.id}:${resolvedIndex}`,
        });
        $((K) => [...K, result.answer || "没有收到回答，请重试"]);
      } catch (error) {
        setLuminError(error.message || "Lumin 暂时无法回答，请稍后再试。");
      } finally {
        setLuminPending(false);
      }
    };
  const saveQuiz = React.useCallback(async () => {
    if (submittedRef.current || !i.length) return;
    submittedRef.current = true;
    attemptRef.current ||= crypto.randomUUID();
    setQuizSave({ pending: true, error: "", result: null });
    try {
      const result = await api(`/courses/${encodeURIComponent(n.id)}/lessons/${resolvedIndex}/quiz`, "POST", {
        attemptId: attemptRef.current,
        answers: answersRef.current,
        durationSeconds: O,
        resourceKind: "bank",
        resourceVersion: remote.lesson?.resourceVersions?.bank,
      });
      await refreshLearning();
      setQuizSave({ pending: false, error: "", result });
    } catch (error) {
      submittedRef.current = false;
      setQuizSave({ pending: false, error: error.message, result: null });
    }
  }, [n.id, resolvedIndex, O, i.length]);
  React.useEffect(() => {
    if (h === "complete") saveQuiz();
  }, [h, saveQuiz]);
  if (remote.loading || remote.error)
    return jsxRuntime.jsx(LoadPanel, { error: remote.error, onRetry: remote.retry, onBack: u, message: "正在加载章节测验…" });
  if (!resourceTypes(remote.lesson).includes("bank") || !i.length)
    return jsxRuntime.jsx(LoadPanel, { error: "本章测验暂未发布，返回课程选择其他资料。", onRetry: remote.retry, onBack: u });
  if (h === "complete") {
    const D = y.filter(Boolean).length,
      K = Math.round((D / i.length) * 100),
      Z = y.reduce(
        (ae, S) => {
          const Y = S ? ae.current + 1 : 0;
          return { current: Y, maximum: Math.max(ae.maximum, Y) };
        },
        { current: 0, maximum: 0 },
      ).maximum,
      W = `${String(Math.floor(O / 60)).padStart(2, "0")}:${String(O % 60).padStart(2, "0")}`;
    return jsxRuntime.jsxs("div", {
      "code-path": "src\\pages\\QuizFlow.tsx:154:7",
      className: "quiz-screen flex min-h-screen flex-col bg-white",
      children: [
        jsxRuntime.jsx("main", {
          "code-path": "src\\pages\\QuizFlow.tsx:155:9",
          className: "flex flex-1 items-center justify-center px-6 py-16",
          children: jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\QuizFlow.tsx:156:11",
            className: "text-center",
            children: [
              jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\QuizFlow.tsx:157:13",
                className:
                  "quiz-success-pop relative mx-auto flex h-40 w-40 items-center justify-center rounded-full bg-[#25b739] text-white shadow-[0_18px_50px_rgba(37,183,57,0.25)]",
                children: [
                  jsxRuntime.jsx(Dm, {
                    "code-path": "src\\pages\\QuizFlow.tsx:157:186",
                    className: "h-20 w-20",
                    strokeWidth: 4,
                  }),
                  jsxRuntime.jsx(hn, {
                    "code-path": "src\\pages\\QuizFlow.tsx:157:233",
                    className:
                      "absolute -right-2 top-2 h-9 w-9 fill-[#ffd83d] text-[#ffd83d]",
                  }),
                ],
              }),
              jsxRuntime.jsx("h1", {
                "code-path": "src\\pages\\QuizFlow.tsx:158:13",
                className: "mt-10 text-4xl font-black text-[#111318]",
                children: "本节测试完成",
              }),
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\QuizFlow.tsx:159:13",
                className: "mt-3 text-lg font-semibold text-[#777b85]",
                children: quizSave.pending ? "正在保存测验结果…" : quizSave.result?.completed ? "测验已通过，本章学习进度已保存。" : "达到 60 分即可完成本章，可以复习后再次测验。",
              }),
              quizSave.error && jsxRuntime.jsxs("div", { role: "alert", className: "mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700", children: [quizSave.error, jsxRuntime.jsx("button", { type: "button", onClick: saveQuiz, className: "ml-3 min-h-11 font-bold underline", children: "重新保存成绩" })] }),
              jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\QuizFlow.tsx:160:13",
                className: "mt-10 flex flex-wrap justify-center gap-12",
                children: [
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\QuizFlow.tsx:161:15",
                    children: [
                      jsxRuntime.jsx(Rm, {
                        "code-path": "src\\pages\\QuizFlow.tsx:161:20",
                        className: "mx-auto h-8 w-8 text-[#5f38ef]",
                      }),
                      jsxRuntime.jsxs("strong", {
                        "code-path": "src\\pages\\QuizFlow.tsx:161:72",
                        className: "mt-2 block text-2xl",
                        children: [Z, " 次"],
                      }),
                      jsxRuntime.jsx("span", {
                        "code-path": "src\\pages\\QuizFlow.tsx:161:134",
                        className: "text-sm text-[#8a8e98]",
                        children: "最多连对",
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\QuizFlow.tsx:162:15",
                    children: [
                      jsxRuntime.jsx(Um, {
                        "code-path": "src\\pages\\QuizFlow.tsx:162:20",
                        className: "mx-auto h-8 w-8 text-[#3488e8]",
                      }),
                      jsxRuntime.jsxs("strong", {
                        "code-path": "src\\pages\\QuizFlow.tsx:162:73",
                        className: "mt-2 block text-2xl",
                        children: [K, "%"],
                      }),
                      jsxRuntime.jsx("span", {
                        "code-path": "src\\pages\\QuizFlow.tsx:162:133",
                        className: "text-sm text-[#8a8e98]",
                        children: "正确率",
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\QuizFlow.tsx:163:15",
                    children: [
                      jsxRuntime.jsx(yl, {
                        "code-path": "src\\pages\\QuizFlow.tsx:163:20",
                        className: "mx-auto h-8 w-8 text-[#25b739]",
                      }),
                      jsxRuntime.jsx("strong", {
                        "code-path": "src\\pages\\QuizFlow.tsx:163:73",
                        className: "mt-2 block text-2xl",
                        children: W,
                      }),
                      jsxRuntime.jsx("span", {
                        "code-path": "src\\pages\\QuizFlow.tsx:163:131",
                        className: "text-sm text-[#8a8e98]",
                        children: "用时",
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        }),
        jsxRuntime.jsx("footer", {
          "code-path": "src\\pages\\QuizFlow.tsx:167:9",
          className: "flex justify-end border-t border-black/[0.08] px-8 py-6",
          children: jsxRuntime.jsx("button", {
            "code-path": "src\\pages\\QuizFlow.tsx:167:85",
            type: "button",
            onClick: u,
            className:
              "rounded-xl bg-[#5f38ef] px-8 py-4 text-lg font-black text-white shadow-lg",
            children: "完成并返回",
          }),
        }),
      ],
    });
  }
  if (h === "explanation")
    return jsxRuntime.jsxs("div", {
      "code-path": "src\\pages\\QuizFlow.tsx:174:7",
      className: "quiz-screen flex min-h-screen flex-col bg-[#65676e] pt-6",
      children: [
        jsxRuntime.jsx("main", {
          "code-path": "src\\pages\\QuizFlow.tsx:175:9",
          className:
            "quiz-rise flex-1 overflow-y-auto rounded-t-[24px] bg-white px-6 pb-36 pt-12",
          children: jsxRuntime.jsxs("article", {
            "code-path": "src\\pages\\QuizFlow.tsx:176:11",
            className: "mx-auto max-w-2xl",
            children: [
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\QuizFlow.tsx:177:13",
                className: "text-xs font-bold text-[#9a9da6]",
                children: "答案解析",
              }),
              jsxRuntime.jsx("h1", {
                "code-path": "src\\pages\\QuizFlow.tsx:178:13",
                className: "mt-2 text-3xl font-black text-[#111318]",
                children: G.theoryTitle,
              }),
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\QuizFlow.tsx:179:13",
                className:
                  "mt-6 text-[17px] font-medium leading-[1.95] text-[#30333a]",
                children: G.explanation,
              }),
              jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\QuizFlow.tsx:180:13",
                className: "mt-6 flex items-center justify-between",
                children: [
                  jsxRuntime.jsxs("button", {
                    "code-path": "src\\pages\\QuizFlow.tsx:181:15",
                    type: "button",
                    onClick: fe,
                    className: `flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-extrabold shadow-sm ${N ? "border-[#6038ef]/25 bg-[#f0ebff] text-[#6038ef]" : "border-black/[0.10]"}`,
                    children: [
                      jsxRuntime.jsx(bn, {
                        "code-path": "src\\pages\\QuizFlow.tsx:181:251",
                        className: `h-5 w-5 ${N ? "fill-current" : ""}`,
                      }),
                      N ? "已收藏" : "书签",
                    ],
                  }),
                  jsxRuntime.jsxs("button", {
                    "code-path": "src\\pages\\QuizFlow.tsx:182:15",
                    type: "button",
                    onClick: () => M((D) => !D),
                    className:
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-extrabold text-[#686c77] hover:bg-[#f0ebff] hover:text-[#6038ef]",
                    children: [
                      jsxRuntime.jsx(hn, {
                        "code-path": "src\\pages\\QuizFlow.tsx:182:224",
                        className: "h-5 w-5",
                      }),
                      "Lumin",
                    ],
                  }),
                ],
              }),
              _ &&
                jsxRuntime.jsxs("div", {
                  "code-path": "src\\pages\\QuizFlow.tsx:185:15",
                  className:
                    "quiz-rise mt-6 rounded-2xl border border-black/[0.09] bg-white p-5 shadow-[0_8px_28px_rgba(17,19,24,0.08)]",
                  children: [
                    H.length > 0 &&
                      jsxRuntime.jsx("div", {
                        "code-path": "src\\pages\\QuizFlow.tsx:186:46",
                        className: "mb-4 space-y-2",
                        children: H.map((D, K) =>
                          jsxRuntime.jsx(
                            "p",
                            {
                              "code-path": "src\\pages\\QuizFlow.tsx:186:117",
                              className: `rounded-xl px-4 py-3 text-sm font-semibold leading-6 ${D.startsWith("你：") ? "ml-12 bg-[#6038ef] text-white" : "mr-12 bg-[#eef2ff] text-[#555a75]"}`,
                              children: D.startsWith("你：") ? D : jsxRuntime.jsx(Markdown, { text: D, audience: "learner" }),
                            },
                            K,
                          ),
                        ),
                      }),
                    luminPending && jsxRuntime.jsx("p", { className: "mr-12 rounded-xl bg-[#eef2ff] px-4 py-3 text-sm font-semibold leading-6 text-[#555a75]", role: "status", children: "Lumin 正在结合题目解析回答…" }),
                    luminError && jsxRuntime.jsxs("div", { className: "mr-12 flex flex-wrap items-center gap-3 rounded-xl bg-[#fff2f4] px-4 py-3 text-sm font-semibold text-[#b63d52]", role: "alert", children: [jsxRuntime.jsx("span", { children: luminError }), jsxRuntime.jsx("button", { type: "button", className: "font-extrabold underline", onClick: xe, children: "重试" })] }),
                    jsxRuntime.jsxs("div", {
                      "code-path": "src\\pages\\QuizFlow.tsx:187:17",
                      className: "flex items-center gap-3",
                      children: [
                        jsxRuntime.jsx(fn, {
                          "code-path": "src\\pages\\QuizFlow.tsx:187:58",
                          className: "h-5 w-5 text-[#4d83d1]",
                        }),
                        jsxRuntime.jsx("input", {
                          "code-path": "src\\pages\\QuizFlow.tsx:187:100",
                          value: B,
                          onChange: (D) => Q(D.target.value),
                          onKeyDown: (D) => D.key === "Enter" && xe(),
                          disabled: luminPending,
                          placeholder: "引用本题解析向 Lumin 老师提问...",
                          className:
                            "min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none",
                        }),
                        jsxRuntime.jsx("button", {
                          "code-path": "src\\pages\\QuizFlow.tsx:187:362",
                          type: "button",
                          onClick: xe,
                          disabled: luminPending,
                          className:
                            "flex h-9 w-9 items-center justify-center rounded-full bg-[#6038ef] text-white",
                          children: jsxRuntime.jsx(ic, {
                            "code-path": "src\\pages\\QuizFlow.tsx:187:502",
                            className: "h-4 w-4",
                          }),
                        }),
                      ],
                    }),
                  ],
                }),
            ],
          }),
        }),
        jsxRuntime.jsxs("footer", {
          "code-path": "src\\pages\\QuizFlow.tsx:192:9",
          className: `fixed inset-x-0 bottom-0 flex items-center justify-between border-t px-7 py-5 ${ne ? "border-[#b9edc1] bg-[#ebfff0]" : "border-[#ffd1d1] bg-[#fff0f0]"}`,
          children: [
            jsxRuntime.jsxs("span", {
              "code-path": "src\\pages\\QuizFlow.tsx:193:11",
              className: `flex items-center gap-2 rounded-full border-2 px-4 py-2 text-base font-black ${ne ? "border-[#25b739] text-[#25b739]" : "border-[#df2929] text-[#df2929]"}`,
              children: [
                ne
                  ? jsxRuntime.jsx(pn, {
                      "code-path": "src\\pages\\QuizFlow.tsx:193:214",
                      className: "h-5 w-5",
                    })
                  : jsxRuntime.jsx(Bh, {
                      "code-path": "src\\pages\\QuizFlow.tsx:193:253",
                      className: "h-5 w-5",
                    }),
                ne ? "正确的！" : "错误！",
              ],
            }),
            jsxRuntime.jsxs("div", {
              "code-path": "src\\pages\\QuizFlow.tsx:194:11",
              className: "flex items-center gap-4",
              children: [
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\QuizFlow.tsx:194:52",
                  type: "button",
                  onClick: () => x(ne ? "correct" : "wrong"),
                  className: "font-extrabold text-[#676b76]",
                  children: "关闭解析",
                }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\QuizFlow.tsx:194:191",
                  type: "button",
                  onClick: se,
                  className: `rounded-xl px-6 py-3 font-black text-white ${ne ? "bg-[#25b739]" : "bg-[#df2929]"}`,
                  children: "继续",
                }),
              ],
            }),
          ],
        }),
      ],
    });
  const Se = h === "correct" || h === "wrong";
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\pages\\QuizFlow.tsx:202:5",
    className: "quiz-screen flex min-h-screen flex-col bg-white",
    children: [
      jsxRuntime.jsxs("header", {
        "code-path": "src\\pages\\QuizFlow.tsx:203:7",
        className: "mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-6",
        children: [
          jsxRuntime.jsx("button", {
            "code-path": "src\\pages\\QuizFlow.tsx:204:9",
            type: "button",
            onClick: () => R(!0),
            className:
              "flex h-10 w-10 items-center justify-center rounded-full text-[#656a74] hover:bg-[#f2f2f4]",
            "aria-label": "退出测试",
            children: jsxRuntime.jsx(uc, {
              "code-path": "src\\pages\\QuizFlow.tsx:204:188",
              className: "h-6 w-6",
            }),
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\pages\\QuizFlow.tsx:205:9",
            className: "h-2 flex-1 overflow-hidden rounded-full bg-[#eef0f3]",
            children: jsxRuntime.jsx("div", {
              "code-path": "src\\pages\\QuizFlow.tsx:205:79",
              className:
                "h-full rounded-full bg-[#111318] transition-all duration-500",
              style: { width: `${be}%` },
            }),
          }),
          jsxRuntime.jsxs("span", {
            "code-path": "src\\pages\\QuizFlow.tsx:206:9",
            className: "text-sm font-extrabold text-[#8a8e98]",
            children: [d + 1, "/", i.length],
          }),
        ],
      }),
      jsxRuntime.jsxs("main", {
        "code-path": "src\\pages\\QuizFlow.tsx:208:7",
        className: "mx-auto w-full max-w-3xl flex-1 px-6 pb-32 pt-8",
        children: [
          jsxRuntime.jsx("h1", {
            "code-path": "src\\pages\\QuizFlow.tsx:209:9",
            className:
              "text-center text-xl font-black leading-8 text-[#111318]",
            children: G.question,
          }),
          jsxRuntime.jsx("div", {
            "code-path": "src\\pages\\QuizFlow.tsx:210:9",
            className: "mt-7 space-y-3",
            children: G.options.map((D, K) => {
              const Z = m === K,
                W = h === "wrong" && Z,
                ae = h === "correct" && Z;
              return jsxRuntime.jsxs(
                "button",
                {
                  "code-path": "src\\pages\\QuizFlow.tsx:216:15",
                  type: "button",
                  disabled: Se,
                  onClick: () => b(K),
                  className: `quiz-option flex w-full items-center justify-between rounded-2xl border px-5 py-5 text-left text-base font-semibold transition-all ${W ? "border-[3px] border-[#df2929] bg-[#fff0f0] text-[#9c2020]" : ae ? "border-[3px] border-[#25b739] bg-[#ecfff0] text-[#167c2a]" : Z ? "border-[3px] border-[#6038ef] bg-[#f3efff]" : Se ? "border-black/[0.06] text-[#aaaeb5]" : "border-black/[0.11] hover:-translate-y-0.5 hover:border-[#6038ef]/40 hover:shadow-sm"}`,
                  children: [
                    jsxRuntime.jsx("span", {
                      "code-path": "src\\pages\\QuizFlow.tsx:217:17",
                      children: D,
                    }),
                    jsxRuntime.jsx("span", {
                      "code-path": "src\\pages\\QuizFlow.tsx:217:38",
                      className: "ml-4 text-sm font-bold",
                      children: K + 1,
                    }),
                  ],
                },
                D,
              );
            }),
          }),
        ],
      }),
      jsxRuntime.jsx("footer", {
        "code-path": "src\\pages\\QuizFlow.tsx:223:7",
        className: `fixed inset-x-0 bottom-0 border-t px-7 py-5 transition-colors ${h === "wrong" ? "border-[#ffd1d1] bg-[#fff0f0]" : h === "correct" ? "border-[#b9edc1] bg-[#ebfff0]" : "border-black/[0.08] bg-white"}`,
        children: jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\QuizFlow.tsx:224:9",
          className: "mx-auto flex max-w-5xl items-center justify-between",
          children: [
            h === "wrong"
              ? jsxRuntime.jsxs("span", {
                  "code-path": "src\\pages\\QuizFlow.tsx:225:32",
                  className:
                    "flex items-center gap-2 rounded-full border-2 border-[#df2929] px-4 py-2 font-black text-[#df2929]",
                  children: [
                    jsxRuntime.jsx(Bh, {
                      "code-path": "src\\pages\\QuizFlow.tsx:225:149",
                      className: "h-5 w-5",
                    }),
                    "错误！",
                  ],
                })
              : h === "correct"
                ? jsxRuntime.jsxs("span", {
                    "code-path": "src\\pages\\QuizFlow.tsx:225:215",
                    className:
                      "flex items-center gap-2 rounded-full border-2 border-[#25b739] px-4 py-2 font-black text-[#25b739]",
                    children: [
                      jsxRuntime.jsx(pn, {
                        "code-path": "src\\pages\\QuizFlow.tsx:225:332",
                        className: "h-5 w-5",
                      }),
                      "正确的！",
                    ],
                  })
                : jsxRuntime.jsx("span", {
                    "code-path": "src\\pages\\QuizFlow.tsx:225:382",
                  }),
            answerState.error && jsxRuntime.jsx("p", { role: "alert", className: "max-w-sm text-sm font-semibold text-red-600", children: answerState.error }),
            h === "answering"
              ? jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\QuizFlow.tsx:227:13",
                  type: "button",
                  disabled: m === null || answerState.pending,
                  onClick: ke,
                  className:
                    "rounded-xl bg-[#5f38ef] px-7 py-3.5 font-black text-white shadow-md transition disabled:bg-[#eef0f3] disabled:text-[#b4b8c0] disabled:shadow-none",
                  children: answerState.pending ? "正在判分…" : "提交答案",
                })
              : jsxRuntime.jsxs("div", {
                  "code-path": "src\\pages\\QuizFlow.tsx:229:13",
                  className: "flex items-center gap-4",
                  children: [
                    jsxRuntime.jsx("button", {
                      "code-path": "src\\pages\\QuizFlow.tsx:229:54",
                      type: "button",
                      onClick: () => x("explanation"),
                      className: `rounded-xl px-5 py-3 font-black ${h === "wrong" ? "bg-[#df2929] text-white" : "text-[#258c3b]"}`,
                      children: h === "wrong" ? "为什么？" : "观点理论",
                    }),
                    jsxRuntime.jsx("button", {
                      "code-path": "src\\pages\\QuizFlow.tsx:229:276",
                      type: "button",
                      onClick: se,
                      className: `rounded-xl px-6 py-3 font-black text-white ${h === "wrong" ? "bg-[#df2929]" : "bg-[#25b739]"}`,
                      children: "继续",
                    }),
                  ],
                }),
          ],
        }),
      }),
      z &&
        jsxRuntime.jsx(Jv, {
          "code-path": "src\\pages\\QuizFlow.tsx:233:23",
          onContinue: () => R(!1),
          onExit: u,
        }),
    ],
  });
}

function dc({ course: n, lessonTitle: r, lessonIndex: lessonNumber, onExit: u, initialQuestionIndex = 0, focusQuestionId = "" }) {
  const [i, d] = React.useState(!0);
  return i
    ? jsxRuntime.jsx(zs, {
        "code-path": "src\\pages\\QuizFlow.tsx:240:23",
        onComplete: () => d(!1),
      })
    : jsxRuntime.jsx(QuizFlow, {
        "code-path": "src\\pages\\QuizFlow.tsx:241:10",
        course: n,
        lessonTitle: r,
        lessonIndex: lessonNumber,
        onExit: u,
        initialQuestionIndex,
        focusQuestionId,
      });
}

const lm = {
  ds: [
    "数据结构描述了数据之间的逻辑关系，以及这些关系在计算机中的存储方式。",
    "选择结构时，需要同时考虑访问、插入、删除和排序等操作的成本。",
    "时间复杂度与空间复杂度能够帮助我们在不同方案之间做出可解释的选择。",
  ],
  co: [
    "计算机组成关注指令如何经过数据通路，最终由硬件完成运算。",
    "处理器、存储器与输入输出设备通过总线和控制信号协同工作。",
    "理解层次化设计，是分析现代计算机性能差异的关键。",
  ],
  os: [
    "操作系统在应用程序与硬件之间建立了安全、统一的资源抽象。",
    "进程调度、内存管理和文件系统共同决定程序的执行体验。",
    "并发问题需要从共享资源、执行顺序和同步机制三个角度分析。",
  ],
  cn: [
    "网络协议通过分层来降低复杂度，每一层都提供清晰的服务边界。",
    "数据传输需要同时处理寻址、路由、差错控制与拥塞控制。",
    "理解封装与解封装过程，可以快速定位实际网络故障。",
  ],
  agent: [
    "智能体通过感知环境、形成计划并调用工具来完成目标。",
    "记忆机制让智能体能够保留上下文，并利用历史经验修正下一步行动。",
    "多智能体协作需要明确角色、共享状态与冲突解决机制。",
  ],
};

function Wv(n, r) {
  const u = lm[n.id] ?? lm.ds;
  return [
    {
      id: "concept",
      eyebrow: "概念 1",
      heading: `${r}是什么`,
      text: `${u[0]} 在本节中，我们会从基本概念出发，把抽象术语与真实场景连接起来。理解“为什么需要它”，比单纯记忆定义更重要，也能帮助你在后续练习中快速识别问题类型。`,
    },
    {
      id: "mechanism",
      eyebrow: "概念 2",
      heading: "核心机制与工作过程",
      text: `${u[1]} 学习时可以把整个过程拆成输入、状态变化和输出三个部分，再追踪每一步涉及的数据与约束。这样既能看清局部操作，也不会失去对整体流程的理解。`,
    },
    {
      id: "analysis",
      eyebrow: "练习 1",
      heading: "如何分析与选择方案",
      text: `${u[2]} 面对具体问题时，先明确目标和限制条件，再列出可行方案并比较各自代价。不要只寻找“唯一正确答案”，实际工程中更重要的是根据场景作出合理取舍。`,
    },
    {
      id: "practice",
      eyebrow: "练习 2",
      heading: "从例子走向实践",
      text: `尝试用自己的语言复述${r}的工作过程，并为每个关键步骤准备一个小例子。如果某一步无法解释清楚，就回到它依赖的概念继续追问。通过“解释—验证—修正”的循环，可以把短期记忆转化为稳定理解。`,
    },
    {
      id: "summary",
      eyebrow: "本节总结",
      heading: "建立可迁移的知识框架",
      text: `完成本节后，你应该能够说明${r}解决了什么问题、核心过程如何运行，以及在不同条件下应该怎样选择方案。接下来的测试将通过判断、选择与场景题检验这些能力。`,
    },
  ];
}

function Lecture({
  course: n,
  lessonTitle: r,
  lessonIndex: u,
  resourceKind = "lecture",
  focusSectionId = "",
  onBack: i,
  onNavigate: d,
}) {
  const remote = useLesson(n, u);
  const references = React.useMemo(() => lessonReferences(remote.lesson, resourceKind), [remote.lesson, resourceKind]);
  const referencePrefix = `lecture-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const p = React.useMemo(() => lessonSections(remote.lesson, resourceKind), [remote.lesson, resourceKind]),
    [m, b] = React.useState(pu),
    [h, x] = React.useState(null),
    [z, R] = React.useState(!1),
    _ = React.useRef(null);
  React.useEffect(() => {
    if (!remote.lesson) return;
    api(`/courses/${encodeURIComponent(n.id)}/lessons/${u}/progress`, "PUT", {
      read: true,
      resourceKind,
      resourceVersion: remote.lesson.resourceVersions?.[resourceKind],
    }).catch(
      () => undefined,
    );
  }, [n.id, u, remote.lesson]);
  React.useEffect(() => {
    if (!focusSectionId || !p.length) return;
    const target = document.getElementById(`lecture-section-${u}-${focusSectionId}`);
    target?.scrollIntoView({ block: "start" });
  }, [focusSectionId, p.length, u]);
  const B = (G) => {
      const ne = `${n.id}-${u}-${G.id}`;
      b((be) => {
        const se = be.some((fe) => fe.id === ne)
          ? be.filter((fe) => fe.id !== ne)
          : [
              {
                id: ne,
                courseId: n.id,
                courseName: n.name,
                lessonIndex: u,
                sectionId: G.id,
                lessonTitle: r,
                heading: G.heading,
                text: G.text,
                resourceKind,
                resourceVersion: remote.lesson?.resourceVersions?.[resourceKind],
                sourceDocId: remote.lesson?.sources?.[0]?.id || "",
                savedAt: new Date().toISOString(),
              },
              ...be,
            ];
        return (hu(se), se);
      });
    },
    Q = (G) => {
      (x({ heading: G.heading, text: G.text }),
        window.setTimeout(() => _.current?.focus(), 0));
    };
  if (remote.loading || remote.error)
    return jsxRuntime.jsx(LoadPanel, {
      error: remote.error,
      onRetry: remote.retry,
      onBack: i,
      message: `正在加载“${r}”…`,
    });
  if (!resourceTypes(remote.lesson).includes(resourceKind) || !p.length)
    return jsxRuntime.jsx(LoadPanel, { error: "本章讲义暂未发布，返回课程选择其他资料。", onRetry: remote.retry, onBack: i });
  return z
    ? jsxRuntime.jsx(dc, {
        "code-path": "src\\pages\\Lecture.tsx:158:12",
        course: n,
        lessonTitle: r,
        lessonIndex: u,
        onExit: () => R(!1),
      })
    : jsxRuntime.jsxs("div", {
        "code-path": "src\\pages\\Lecture.tsx:162:5",
        className: "h-screen overflow-hidden bg-white",
        children: [
          jsxRuntime.jsx(AppNavigation, {
            "code-path": "src\\pages\\Lecture.tsx:163:7",
            active: "coach",
            onNavigate: d,
          }),
          jsxRuntime.jsxs(gx, {
            "code-path": "src\\pages\\Lecture.tsx:165:7",
            orientation: "horizontal",
            className: "h-[calc(100vh-84px)]",
            children: [
              jsxRuntime.jsx(lc, {
                "code-path": "src\\pages\\Lecture.tsx:166:9",
                defaultSize: "56%",
                minSize: "38%",
                children: jsxRuntime.jsxs("article", {
                  "code-path": "src\\pages\\Lecture.tsx:167:11",
                  className:
                    "h-full overflow-y-auto bg-white px-7 pb-16 pt-8 sm:px-10 lg:px-12",
                  children: [
                    jsxRuntime.jsxs("button", {
                      "code-path": "src\\pages\\Lecture.tsx:168:13",
                      type: "button",
                      onClick: i,
                      className:
                        "flex items-center gap-2 text-sm font-extrabold text-[#747883] transition hover:text-[#6038ef]",
                      children: [
                        jsxRuntime.jsx(lu, {
                          "code-path": "src\\pages\\Lecture.tsx:169:15",
                          className: "h-4 w-4",
                        }),
                        " 返回课程",
                      ],
                    }),
                    jsxRuntime.jsx("h1", {
                      "code-path": "src\\pages\\Lecture.tsx:171:13",
                      className:
                        "mt-6 text-4xl font-black tracking-tight text-[#111318]",
                      children: r,
                    }),
                    jsxRuntime.jsx("p", {
                      "code-path": "src\\pages\\Lecture.tsx:172:13",
                      className:
                        "mt-3 text-base font-semibold leading-7 text-[#747883]",
                      children:
                        "探索本节课的核心概念，理解知识背后的工作方式，并通过练习建立可迁移的解题框架。",
                    }),
                    jsxRuntime.jsxs("div", {
                      "code-path": "src\\pages\\Lecture.tsx:175:13",
                      className:
                        "mt-4 flex flex-wrap items-center gap-4 text-sm font-semibold text-[#7b7f89]",
                      children: [
                        jsxRuntime.jsxs("span", {
                          "code-path": "src\\pages\\Lecture.tsx:176:15",
                          className: "flex items-center gap-1.5",
                          children: [
                            jsxRuntime.jsx(yl, {
                              "code-path": "src\\pages\\Lecture.tsx:176:59",
                              className: "h-4 w-4",
                            }),
                            "预计阅读：",
                            Math.max(1, Math.ceil(p.reduce((sum, item) => sum + item.text.length, 0) / 400)),
                            "分钟",
                          ],
                        }),
                        jsxRuntime.jsxs("span", {
                          "code-path": "src\\pages\\Lecture.tsx:177:15",
                          className: "flex items-center gap-1.5",
                          children: [
                            jsxRuntime.jsx($a, {
                              "code-path": "src\\pages\\Lecture.tsx:177:59",
                              className: "h-4 w-4",
                            }),
                            p.length,
                            "个内容段落",
                          ],
                        }),
                        jsxRuntime.jsx("span", {
                          "code-path": "src\\pages\\Lecture.tsx:178:15",
                          className:
                            "rounded-lg bg-[#f0ebff] px-3 py-1 text-xs font-extrabold text-[#6038ef]",
                          children: "章节讲义",
                        }),
                      ],
                    }),
                    jsxRuntime.jsxs("div", {
                      "code-path": "src\\pages\\Lecture.tsx:181:13",
                      className:
                        "mt-7 flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.08] pb-7",
                      children: [
                        jsxRuntime.jsx("button", {
                          "code-path": "src\\pages\\Lecture.tsx:182:15",
                          type: "button",
                          className:
                            "shrink-0 whitespace-nowrap rounded-xl bg-[#6038ef] px-6 py-3.5 text-sm font-black text-white shadow-[0_7px_18px_rgba(96,56,239,0.22)]",
                          children: "阅读讲义",
                        }),
                        jsxRuntime.jsxs("span", {
                          "code-path": "src\\pages\\Lecture.tsx:185:15",
                          className: "text-sm font-bold text-[#92959e]",
                          children: [n.name, " · 第 ", n.chapters[u]?.orderNo ?? u + 1, " 课"],
                        }),
                      ],
                    }),
                    jsxRuntime.jsx("div", {
                      "code-path": "src\\pages\\Lecture.tsx:188:13",
                      className: "divide-y divide-black/[0.07]",
                      children: p.map((G) => {
                        const ne = `${n.id}-${u}-${G.id}`,
                          be = m.some((ke) => ke.id === ne);
                        return jsxRuntime.jsxs(
                          "section",
                          {
                            "code-path": "src\\pages\\Lecture.tsx:193:19",
                            className: "py-9",
                            id: `lecture-section-${u}-${G.id}`,
                            children: [
                              jsxRuntime.jsx("p", {
                                "code-path": "src\\pages\\Lecture.tsx:194:21",
                                className: "text-xs font-bold text-[#999ca5]",
                                children: G.eyebrow,
                              }),
                              jsxRuntime.jsx("h2", {
                                "code-path": "src\\pages\\Lecture.tsx:195:21",
                                className:
                                  "mt-2 text-2xl font-black text-[#111318]",
                                children: G.heading,
                              }),
                              jsxRuntime.jsx(G.markdown ? "div" : "p", {
                                "code-path": "src\\pages\\Lecture.tsx:196:21",
                                className:
                                  "mt-4 text-[17px] font-medium leading-[1.95] text-[#30333a]",
                                children: G.markdown ? jsxRuntime.jsx(CoursewareMarkdown, { text: G.text, references, prefix: referencePrefix, audience: "learner" }) : G.text,
                              }),
                              jsxRuntime.jsxs("div", {
                                "code-path": "src\\pages\\Lecture.tsx:197:21",
                                className:
                                  "mt-5 flex items-center justify-between",
                                children: [
                                  jsxRuntime.jsxs("button", {
                                    "code-path":
                                      "src\\pages\\Lecture.tsx:198:23",
                                    type: "button",
                                    onClick: () => B(G),
                                    className: `flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-extrabold shadow-sm transition ${be ? "border-[#6038ef]/25 bg-[#f0ebff] text-[#6038ef]" : "border-black/[0.10] bg-white text-[#343740] hover:border-[#6038ef]/35 hover:text-[#6038ef]"}`,
                                    children: [
                                      jsxRuntime.jsx(bn, {
                                        "code-path":
                                          "src\\pages\\Lecture.tsx:203:25",
                                        className: `h-[18px] w-[18px] ${be ? "fill-current" : ""}`,
                                      }),
                                      be ? "已收藏" : "书签",
                                    ],
                                  }),
                                  jsxRuntime.jsxs("button", {
                                    "code-path":
                                      "src\\pages\\Lecture.tsx:206:23",
                                    type: "button",
                                    onClick: () => Q(G),
                                    className:
                                      "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-extrabold text-[#686c77] transition hover:bg-[#f0ebff] hover:text-[#6038ef]",
                                    children: [
                                      jsxRuntime.jsx(hn, {
                                        "code-path":
                                          "src\\pages\\Lecture.tsx:211:25",
                                        className: "h-[18px] w-[18px]",
                                      }),
                                      " Lumin 老师",
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          },
                          G.id,
                        );
                      }),
                    }),
                    jsxRuntime.jsx(CoursewareReferences, { references, prefix: referencePrefix }),
                    jsxRuntime.jsx(ChapterCompletion, { course: n, index: u, lesson: remote.lesson, resourceKind, onQuiz: () => R(!0) }),
                  ],
                }),
              }),
              jsxRuntime.jsx(bx, {
                "code-path": "src\\pages\\Lecture.tsx:230:9",
                withHandle: !0,
                className:
                  "w-2 bg-[#f1f1f4] transition-colors hover:bg-[#ddd6f7] data-[resize-handle-active]:bg-[#6038ef]/25",
              }),
              jsxRuntime.jsx(lc, {
                "code-path": "src\\pages\\Lecture.tsx:232:9",
                defaultSize: "44%",
                minSize: "28%",
                children: jsxRuntime.jsx(TutorChat, { courseId: n.id, lessonIndex: u, lessonTitle: r, quote: h, onClearQuote: () => x(null), inputRef: _ }),
              }),
            ],
          }),
        ],
      });
}

const rn = ["#ffd84a", "#53d4c5", "#8b76ff", "#ff7b72", "#4fa4ff", "#f0b35a"];

function Fv(n, r) {
  const u = n.chapters.map((i) => i.title);
  return [
    {
      kicker: `${n.name} · 第一次讲解`,
      title: r,
      subtitle: "从问题出发，建立本节课的整体知识地图",
      points: ["学习目标", "核心概念", "实践方法"],
      narration: `大家好，欢迎来到${n.name}课程。今天我们将一起学习${r}，先从它解决的核心问题开始。`,
      accent: rn[0],
    },
    {
      kicker: "核心概念",
      title: "为什么需要它？",
      subtitle: "理解需求，比记住定义更重要",
      points: ["明确问题边界", "识别输入与输出", "找到关键约束"],
      narration: `理解${r}的第一步，是明确它为什么出现。请关注问题的输入、预期输出，以及必须满足的限制条件。`,
      accent: rn[1],
    },
    {
      kicker: "工作过程",
      title: "从输入到结果",
      subtitle: "把复杂过程拆解为可观察的步骤",
      points: ["接收输入", "更新内部状态", "生成并验证结果"],
      narration:
        "我们可以把整个工作过程拆成三个阶段。每经过一个阶段，都要检查状态发生了什么变化。",
      accent: rn[2],
    },
    {
      kicker: "对比分析",
      title: "不同方案如何选择？",
      subtitle: "没有脱离场景的唯一最优解",
      points: ["正确性", "时间与空间成本", "可维护性"],
      narration:
        "面对多个可行方案时，不要急着寻找唯一答案。先根据场景比较正确性、资源成本和后续维护难度。",
      accent: rn[3],
    },
    {
      kicker: "知识连接",
      title: "与后续课程的关系",
      subtitle: "把本节内容放回完整课程体系",
      points: u.slice(0, 3),
      narration: `本节知识不是孤立的。它会和${u.slice(0, 3).join("、")}等内容形成相互支撑的知识网络。`,
      accent: rn[4],
    },
    {
      kicker: "本节总结",
      title: "现在，你应该掌握了什么？",
      subtitle: "用自己的语言复述，才是真正理解",
      points: ["说明核心目标", "解释完整过程", "根据场景作出选择"],
      narration: `完成讲解后，请尝试用自己的语言解释${r}。如果这三点都能说清楚，就可以进入练习了。`,
      accent: rn[5],
    },
  ];
}

function Presentation({
  course: n,
  lessonTitle: r,
  lessonIndex: u,
  onBack: i,
  onNavigate: d,
}) {
  const remote = useLesson(n, u);
  const presentation = remote.lesson?.resources?.slides?.presentation || null;
  const p = React.useMemo(() => lessonSlides(remote.lesson), [remote.lesson]),
    [m, b] = React.useState(0),
    [h, x] = React.useState(!1),
    [y, j] = React.useState(1.5),
    [z, R] = React.useState(!1),
    [N, E] = React.useState(!1),
    [_, M] = React.useState(!1),
    ne = p[m] ?? { title: "", subtitle: "", kicker: "", points: [], narration: "", accent: "#b8a3ff" };
  (React.useEffect(() => {
    if (!h || !ne.narration || !("speechSynthesis" in window)) {
      window.speechSynthesis?.cancel();
      return;
    }
    const W = new SpeechSynthesisUtterance(ne.narration);
    return (
      (W.lang = "zh-CN"),
      (W.rate = y),
      (W.onend = () => {
        m >= p.length - 1 ? (x(!1), E(!0)) : (E(!1), b((ae) => ae + 1));
      }),
      window.speechSynthesis.cancel(),
      window.speechSynthesis.speak(W),
      () => window.speechSynthesis.cancel()
    );
  }, [h, ne.narration, m, p.length, y]),
    React.useEffect(() => {
      const W = (ae) => {
        (ae.key === "Escape" && R(!1),
          ae.key === "ArrowLeft" && (E(!1), b((S) => Math.max(0, S - 1))),
          ae.key === "ArrowRight" &&
            (E(!1), b((S) => Math.min(p.length - 1, S + 1))));
      };
      return (
        window.addEventListener("keydown", W),
        () => window.removeEventListener("keydown", W)
      );
    }, [p.length]));
  const be = () => {
      const W = [1, 1.25, 1.5, 2],
        ae = W.indexOf(y);
      j(W[(ae + 1) % W.length]);
    },
    Se = () => {
      (window.speechSynthesis.cancel(), x((W) => !W));
    },
    D = () => {
      (x(!1), E(!1), b((W) => Math.max(0, W - 1)));
    },
    K = () => {
      if (m >= p.length - 1) { x(!1); E(!0); }
      else (x(!1), E(!1), b((W) => Math.min(p.length - 1, W + 1)));
    },
    Z = presentation
      ? jsxRuntime.jsxs("div", {
          className: "flex min-h-0 flex-1 flex-col",
          children: [
            jsxRuntime.jsx(PresentationArtifact, {
              presentation,
              className: "zx-presentation-learner",
              downloadName: `${n.name}-${r}.pptx`.replace(/[\\/:*?"<>|]+/g, "-"),
            }),
            jsxRuntime.jsxs("div", {
              className: "zx-presentation-learning-bar",
              children: [
                jsxRuntime.jsxs("span", {
                  children: [
                    "实际 PPTX · ",
                    presentation.slideCount ? `${presentation.slideCount} 页` : "可下载",
                    " · 支持 Lumin 老师随时提问",
                  ],
                }),
                jsxRuntime.jsxs("div", {
                  className: "zx-presentation-learning-actions",
                  children: [
                    jsxRuntime.jsx("button", {
                      type: "button",
                      className: "is-secondary",
                      onClick: () => R((W) => !W),
                      children: z ? "退出全屏" : "全屏阅读",
                    }),
                    jsxRuntime.jsx("button", {
                      type: "button",
                      className: "is-primary",
                      onClick: () => E(!0),
                      children: "完成本节",
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      : jsxRuntime.jsxs("div", {
      "code-path": "src\\pages\\Presentation.tsx:217:5",
      className: `relative flex min-h-0 flex-1 flex-col ${z ? "bg-[#f4f4f7] p-5 sm:p-8" : ""}`,
      children: [
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\Presentation.tsx:218:7",
          className:
            "relative flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-[#111020] shadow-[0_14px_40px_rgba(12,10,30,0.18)]",
          children: [
            jsxRuntime.jsx("div", {
              "code-path": "src\\pages\\Presentation.tsx:219:9",
              className:
                "pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full opacity-20 blur-2xl",
              style: { background: ne.accent },
            }),
            jsxRuntime.jsxs("div", {
              "code-path": "src\\pages\\Presentation.tsx:220:9",
              className:
                "relative z-10 flex w-full flex-col justify-between p-8 sm:p-10 lg:p-12",
              children: [
                jsxRuntime.jsxs("div", {
                  "code-path": "src\\pages\\Presentation.tsx:221:11",
                  children: [
                    jsxRuntime.jsx("p", {
                      "code-path": "src\\pages\\Presentation.tsx:222:13",
                      className:
                        "text-xs font-black uppercase tracking-[0.22em]",
                      style: { color: ne.accent },
                      children: ne.kicker,
                    }),
                    jsxRuntime.jsx("h2", {
                      "code-path": "src\\pages\\Presentation.tsx:223:13",
                      className:
                        "mt-4 max-w-3xl text-3xl font-black leading-tight text-white lg:text-4xl",
                      children: ne.title,
                    }),
                    jsxRuntime.jsx("p", {
                      "code-path": "src\\pages\\Presentation.tsx:224:13",
                      className:
                        "mt-3 text-sm font-semibold text-white/60 lg:text-base",
                      children: ne.subtitle,
                    }),
                  ],
                }),
                jsxRuntime.jsx("div", {
                  "code-path": "src\\pages\\Presentation.tsx:226:11",
                  className: "mt-8 grid gap-3 sm:grid-cols-3",
                  children: ne.points.map((W, ae) =>
                    jsxRuntime.jsxs(
                      "div",
                      {
                        "code-path": "src\\pages\\Presentation.tsx:228:15",
                        className:
                          "rounded-xl border border-white/10 bg-white/[0.055] px-4 py-4 text-sm font-extrabold text-white/85 backdrop-blur",
                        children: [
                          jsxRuntime.jsxs("span", {
                            "code-path": "src\\pages\\Presentation.tsx:229:17",
                            className: "mb-2 block text-xs font-black",
                            style: { color: ne.accent },
                            children: ["0", ae + 1],
                          }),
                          W,
                        ],
                      },
                      `${W}-${ae}`,
                    ),
                  ),
                }),
                jsxRuntime.jsxs("div", {
                  "code-path": "src\\pages\\Presentation.tsx:234:11",
                  className: "mt-8 flex items-end justify-between",
                  children: [
                    jsxRuntime.jsx("div", {
                      "code-path": "src\\pages\\Presentation.tsx:235:13",
                      className:
                        "h-1 w-32 overflow-hidden rounded-full bg-white/10",
                      children: jsxRuntime.jsx("div", {
                        "code-path": "src\\pages\\Presentation.tsx:236:15",
                        className:
                          "h-full rounded-full transition-all duration-300",
                        style: {
                          width: `${((m + 1) / p.length) * 100}%`,
                          background: ne.accent,
                        },
                      }),
                    }),
                    jsxRuntime.jsx("img", {
                      "code-path": "src\\pages\\Presentation.tsx:238:13",
                      src: n.icon,
                      alt: "",
                      className: "h-14 w-14 object-contain opacity-85",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\Presentation.tsx:243:7",
          className:
            "mt-3 flex h-12 shrink-0 items-center justify-between rounded-xl border border-black/[0.07] bg-white px-3 shadow-sm",
          children: [
            jsxRuntime.jsxs("span", {
              "code-path": "src\\pages\\Presentation.tsx:244:9",
              className: "text-xs font-extrabold text-[#7d818c]",
              children: [m + 1, " / ", p.length],
            }),
            jsxRuntime.jsxs("div", {
              "code-path": "src\\pages\\Presentation.tsx:245:9",
              className: "flex items-center gap-1.5",
              children: [
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\Presentation.tsx:246:11",
                  type: "button",
                  onClick: D,
                  disabled: m === 0,
                  className:
                    "flex h-9 w-9 items-center justify-center rounded-full text-[#555a65] transition hover:bg-[#f0ebff] disabled:opacity-25",
                  "aria-label": "上一页 PPT",
                  children: jsxRuntime.jsx(Mm, {
                    "code-path": "src\\pages\\Presentation.tsx:246:234",
                    className: "h-5 w-5",
                  }),
                }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\Presentation.tsx:247:11",
                  type: "button",
                  onClick: Se,
                  className:
                    "flex h-10 w-10 items-center justify-center rounded-full bg-[#6038ef] text-white shadow-md",
                  "aria-label": h ? "暂停讲解" : "播放讲解",
                  children: h
                    ? jsxRuntime.jsx(I2, {
                        "code-path": "src\\pages\\Presentation.tsx:248:24",
                        className: "h-4 w-4 fill-current",
                      })
                    : jsxRuntime.jsx(Om, {
                        "code-path": "src\\pages\\Presentation.tsx:248:69",
                        className: "ml-0.5 h-4 w-4 fill-current",
                      }),
                }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\Presentation.tsx:250:11",
                  type: "button",
                  onClick: K,
                  className:
                    "flex h-9 w-9 items-center justify-center rounded-full text-[#555a65] transition hover:bg-[#f0ebff] disabled:opacity-25",
                  "aria-label": m === p.length - 1 ? "完成幻灯片阅读" : "下一页 PPT",
                  children: jsxRuntime.jsx(Am, {
                    "code-path": "src\\pages\\Presentation.tsx:250:246",
                    className: "h-5 w-5",
                  }),
                }),
                jsxRuntime.jsxs("button", {
                  "code-path": "src\\pages\\Presentation.tsx:251:11",
                  type: "button",
                  onClick: be,
                  className:
                    "ml-2 rounded-lg bg-[#f0ebff] px-3 py-2 text-xs font-black text-[#6038ef]",
                  title: "调节 Lumin 老师讲解语速",
                  children: [y, "X"],
                }),
              ],
            }),
            jsxRuntime.jsx("button", {
              "code-path": "src\\pages\\Presentation.tsx:253:9",
              type: "button",
              onClick: () => R((W) => !W),
              className:
                "flex h-9 w-9 items-center justify-center rounded-full text-[#555a65] transition hover:bg-[#f0ebff]",
              "aria-label": z ? "退出全屏" : "全屏显示 PPT",
              children: z
                ? jsxRuntime.jsx(J2, {
                    "code-path": "src\\pages\\Presentation.tsx:254:25",
                    className: "h-5 w-5",
                  })
                : jsxRuntime.jsx(V2, {
                    "code-path": "src\\pages\\Presentation.tsx:254:61",
                    className: "h-5 w-5",
                  }),
            }),
          ],
        }),
        !z &&
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\Presentation.tsx:259:9",
            className:
              "mt-3 rounded-2xl border border-black/[0.07] bg-white p-4 shadow-sm",
            children: [
              jsxRuntime.jsxs("p", {
                "code-path": "src\\pages\\Presentation.tsx:260:11",
                className:
                  "flex items-center gap-2 text-xs font-extrabold text-[#4f85d0]",
                children: [
                  jsxRuntime.jsx(fn, {
                    "code-path": "src\\pages\\Presentation.tsx:260:88",
                    className: "h-4 w-4",
                  }),
                  "Lumin 老师",
                ],
              }),
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\Presentation.tsx:261:11",
                className:
                  "mt-2 text-sm font-semibold leading-6 text-[#575b66]",
                children: ne.narration,
              }),
            ],
          }),
        N &&
          jsxRuntime.jsx("div", {
            "code-path": "src\\pages\\Presentation.tsx:266:9",
            className: `absolute z-30 flex items-center justify-center bg-white/95 p-6 backdrop-blur-md ${z ? "inset-0" : "inset-0 rounded-2xl"}`,
            children: jsxRuntime.jsxs("div", {
              "code-path": "src\\pages\\Presentation.tsx:267:11",
              className:
                "w-full max-w-xl rounded-3xl bg-[#f7f5fc] px-8 py-10 text-center shadow-[0_24px_70px_rgba(49,32,96,0.16)] sm:px-12",
              children: [
                jsxRuntime.jsx(pn, {
                  "code-path": "src\\pages\\Presentation.tsx:268:13",
                  className: "mx-auto h-12 w-12 text-[#25ad4d]",
                }),
                jsxRuntime.jsx("h2", {
                  "code-path": "src\\pages\\Presentation.tsx:269:13",
                  className: "mt-4 text-3xl font-black text-[#111318]",
                  children: "本节 PPT 讲解已完成",
                }),
                jsxRuntime.jsx(ChapterCompletion, { course: n, index: u, lesson: remote.lesson, resourceKind: "slides", onQuiz: () => { R(!1); M(!0); } }),
                jsxRuntime.jsx("button", {
                  "code-path": "src\\pages\\Presentation.tsx:274:13",
                  type: "button",
                  onClick: () => E(!1),
                  className:
                    "mt-3 rounded-lg px-5 py-2 text-sm font-extrabold text-[#777b85] transition hover:bg-white hover:text-[#6038ef]",
                  children: "返回最后一页",
                }),
              ],
            }),
          }),
      ],
    });
  if (remote.loading || remote.error)
    return jsxRuntime.jsx(LoadPanel, { error: remote.error, onRetry: remote.retry, onBack: i, message: "正在加载本章幻灯片…" });
  if (!resourceTypes(remote.lesson).includes("slides") || !p.length)
    return jsxRuntime.jsx(LoadPanel, { error: "本章幻灯片暂未发布，返回课程选择其他资料。", onRetry: remote.retry, onBack: i });
  return _
    ? jsxRuntime.jsx(dc, {
        "code-path": "src\\pages\\Presentation.tsx:284:12",
        course: n,
        lessonTitle: r,
        lessonIndex: u,
        onExit: () => M(!1),
      })
    : z
      ? jsxRuntime.jsx("div", {
          "code-path": "src\\pages\\Presentation.tsx:288:12",
          className: "fixed inset-0 z-[200] flex bg-[#f4f4f7]",
          children: Z,
        })
      : jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\Presentation.tsx:292:5",
          className: "h-screen overflow-hidden bg-white",
          children: [
            jsxRuntime.jsx(AppNavigation, {
              "code-path": "src\\pages\\Presentation.tsx:293:7",
              active: "coach",
              onNavigate: d,
            }),
            jsxRuntime.jsxs(gx, {
              "code-path": "src\\pages\\Presentation.tsx:294:7",
              orientation: "horizontal",
              className: "h-[calc(100vh-84px)]",
              children: [
                jsxRuntime.jsx(lc, {
                  "code-path": "src\\pages\\Presentation.tsx:295:9",
                  defaultSize: "62%",
                  minSize: "42%",
                  children: jsxRuntime.jsxs("main", {
                    "code-path": "src\\pages\\Presentation.tsx:296:11",
                    className:
                      "flex h-full min-h-0 flex-col px-6 pb-5 pt-5 sm:px-8",
                    children: [
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\Presentation.tsx:297:13",
                        className:
                          "mb-4 flex shrink-0 items-center justify-between gap-5",
                        children: [
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Presentation.tsx:298:15",
                            children: [
                              jsxRuntime.jsxs("button", {
                                "code-path":
                                  "src\\pages\\Presentation.tsx:299:17",
                                type: "button",
                                onClick: i,
                                className:
                                  "flex items-center gap-2 text-xs font-extrabold text-[#747883] transition hover:text-[#6038ef]",
                                children: [
                                  jsxRuntime.jsx(lu, {
                                    "code-path":
                                      "src\\pages\\Presentation.tsx:299:162",
                                    className: "h-4 w-4",
                                  }),
                                  "返回课程",
                                ],
                              }),
                              jsxRuntime.jsx("h1", {
                                "code-path":
                                  "src\\pages\\Presentation.tsx:300:17",
                                className:
                                  "mt-2 text-2xl font-black text-[#111318]",
                                children: r,
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("span", {
                            "code-path": "src\\pages\\Presentation.tsx:302:15",
                            className:
                              "shrink-0 rounded-lg bg-[#f0ebff] px-3 py-2 text-xs font-extrabold text-[#6038ef]",
                            children: [n.name, " · 第 ", n.chapters[u]?.orderNo ?? u + 1, " 课"],
                          }),
                        ],
                      }),
                      Z,
                    ],
                  }),
                }),
                jsxRuntime.jsx(bx, {
                  "code-path": "src\\pages\\Presentation.tsx:308:9",
                  withHandle: !0,
                  className:
                    "w-2 bg-[#f1f1f4] transition-colors hover:bg-[#ddd6f7]",
                }),
                jsxRuntime.jsx(lc, {
                  "code-path": "src\\pages\\Presentation.tsx:310:9",
                  defaultSize: "38%",
                  minSize: "28%",
                  children: jsxRuntime.jsx(TutorChat, { courseId: n.id, lessonIndex: u, lessonTitle: r, context: presentation ? "" : `${ne.title}\n${ne.points.join("\n")}`, onSend: () => { x(!1); window.speechSynthesis?.cancel(); } }),
                }),
              ],
            }),
          ],
        });
}

const Iv = {
    ds: { updated: "2026年7月28日" },
    co: { updated: "2026年7月26日" },
    os: { updated: "2026年7月30日" },
    cn: { updated: "2026年7月25日" },
    agent: { updated: "2026年8月1日" },
  },
  e3 = {
    ds: "从数据的逻辑关系出发，理解常见结构的存储方式、操作方法与算法效率。",
    co: "从数据表示到处理器结构，逐步建立计算机硬件系统的完整认知。",
    os: "理解操作系统管理进程、内存、文件与硬件资源的核心机制。",
    cn: "沿着网络分层模型，掌握数据从发送端到接收端的完整传输过程。",
    agent: "围绕感知、规划、记忆和协作，建立智能体系统的核心知识框架。",
  };

function CourseDetail({
  course: n,
  favorite: r,
  onToggleFavorite: u,
  onNavigate: i,
  onBack: d,
  initialLectureIndex: p,
  initialPresentationIndex: m,
  initialQuizIndex: b,
}) {
  const h = bs(n),
    x = n.updatedAt,
    y = n.chapters.findIndex((O) => !O.done),
    j = y >= 0 ? y : 0,
    [z, R] = React.useState(null),
    [N, E] = React.useState(() => {
      return p !== void 0 && n.chapters[p] ? p : null;
    }),
    [_, M] = React.useState(null),
    [B, Q] = React.useState(() => (m !== void 0 && n.chapters[m] ? m : null)),
    [H, $] = React.useState(() => (b !== void 0 && n.chapters[b] ? b : null));
  return H !== null
    ? jsxRuntime.jsx(dc, {
        "code-path": "src\\pages\\CourseDetail.tsx:73:12",
        course: n,
        lessonTitle: n.chapters[H].title,
        lessonIndex: H,
        onExit: () => $(null),
      })
    : _ !== null
      ? jsxRuntime.jsx(zs, {
          "code-path": "src\\pages\\CourseDetail.tsx:78:7",
          onComplete: () => {
            (Q(_), M(null));
          },
        })
      : B !== null
        ? jsxRuntime.jsx(Presentation, {
            "code-path": "src\\pages\\CourseDetail.tsx:89:7",
            course: n,
            lessonTitle: n.chapters[B].title,
            lessonIndex: B,
            onBack: () => Q(null),
            onNavigate: i,
          })
        : N !== null
          ? jsxRuntime.jsx(Lecture, {
              "code-path": "src\\pages\\CourseDetail.tsx:101:7",
              course: n,
              lessonTitle: n.chapters[N].title,
              lessonIndex: N,
              onBack: () => E(null),
              onNavigate: i,
            })
          : jsxRuntime.jsxs("div", {
              "code-path": "src\\pages\\CourseDetail.tsx:112:5",
              className: "min-h-screen bg-white",
              children: [
                jsxRuntime.jsx(AppNavigation, {
                  "code-path": "src\\pages\\CourseDetail.tsx:113:7",
                  active: "courses",
                  onNavigate: i,
                }),
                jsxRuntime.jsxs("main", {
                  "code-path": "src\\pages\\CourseDetail.tsx:115:7",
                  className:
                    "mx-auto max-w-[1220px] px-5 pb-20 pt-8 sm:px-8 lg:pt-12",
                  children: [
                    jsxRuntime.jsxs("button", {
                      "code-path": "src\\pages\\CourseDetail.tsx:116:9",
                      type: "button",
                      onClick: d,
                      className:
                        "mb-7 inline-flex items-center gap-2 text-sm font-extrabold text-[#747883] transition hover:text-[#6c0ef2]",
                      children: [
                        jsxRuntime.jsx("span", {
                          "code-path": "src\\pages\\CourseDetail.tsx:121:11",
                          "aria-hidden": !0,
                          children: "←",
                        }),
                        " 全部课程",
                      ],
                    }),
                    jsxRuntime.jsxs("div", {
                      "code-path": "src\\pages\\CourseDetail.tsx:124:9",
                      className:
                        "grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_360px]",
                      children: [
                        jsxRuntime.jsxs("section", {
                          "code-path": "src\\pages\\CourseDetail.tsx:125:11",
                          className: "min-w-0",
                          children: [
                            jsxRuntime.jsx("h1", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:126:13",
                              className:
                                "text-4xl font-black tracking-tight text-[#111318] sm:text-5xl",
                              children: n.name,
                            }),
                            jsxRuntime.jsx("p", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:127:13",
                              className:
                                "mt-5 max-w-3xl text-base font-semibold leading-8 text-[#717580] sm:text-lg",
                              children: n.description,
                            }),
                            jsxRuntime.jsxs("div", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:131:13",
                              className:
                                "mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm font-semibold text-[#777b85]",
                              children: [
                                jsxRuntime.jsx("span", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:132:15",
                                  className:
                                    "h-1.5 w-24 overflow-hidden rounded-full bg-[#ececf0]",
                                  children: jsxRuntime.jsx("span", {
                                    "code-path":
                                      "src\\pages\\CourseDetail.tsx:133:17",
                                    className:
                                      "block h-full rounded-full bg-[#6c0ef2]",
                                    style: { width: `${h.percent}%` },
                                  }),
                                }),
                                jsxRuntime.jsxs("span", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:135:15",
                                  children: ["已完成 ", h.percent, "%"],
                                }),
                                jsxRuntime.jsxs("span", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:136:15",
                                  className: "flex items-center gap-1.5",
                                  children: [
                                    jsxRuntime.jsx(nu, {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:136:59",
                                      className: "h-4 w-4",
                                    }),
                                    n.level,
                                  ],
                                }),
                                jsxRuntime.jsxs("span", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:137:15",
                                  className: "flex items-center gap-1.5",
                                  children: [
                                    jsxRuntime.jsx(yl, {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:137:59",
                                      className: "h-4 w-4",
                                    }),
                                    n.duration,
                                    "小时",
                                  ],
                                }),
                              ],
                            }),
                            x && jsxRuntime.jsxs("p", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:140:13",
                              className:
                                "mt-5 flex items-center gap-2 text-sm font-semibold text-[#777b85]",
                              children: [
                                jsxRuntime.jsx(_m, {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:141:15",
                                  className: "h-[18px] w-[18px]",
                                }),
                                " 更新于",
                                x,
                              ],
                            }),
                            jsxRuntime.jsxs("div", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:144:13",
                              className:
                                "mt-8 flex items-center justify-between border-b border-black/[0.08] pb-7",
                              children: [
                                jsxRuntime.jsx("button", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:145:15",
                                  type: "button",
                                  onClick: () => R(j),
                                  className:
                                    "rounded-xl bg-[#6038ef] px-6 py-3.5 text-sm font-black text-white shadow-[0_7px_18px_rgba(96,56,239,0.24)] transition hover:-translate-y-0.5 hover:bg-[#512bdc]",
                                  children: "继续学习",
                                }),
                                jsxRuntime.jsxs("div", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:152:15",
                                  className: "flex items-center gap-2",
                                  children: [
                                    jsxRuntime.jsx("button", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:153:17",
                                      type: "button",
                                      onClick: u,
                                      className: `flex h-11 w-11 items-center justify-center rounded-full transition ${r ? "bg-[#efe8ff] text-[#6c0ef2]" : "text-[#555a65] hover:bg-[#f3f1f6]"}`,
                                      "aria-label": r
                                        ? "取消收藏课程"
                                        : "收藏课程",
                                      "aria-pressed": r,
                                      children: jsxRuntime.jsx(bn, {
                                        "code-path":
                                          "src\\pages\\CourseDetail.tsx:160:19",
                                        className: `h-5 w-5 ${r ? "fill-current" : ""}`,
                                      }),
                                    }),
                                    jsxRuntime.jsx("button", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:162:17",
                                      type: "button",
                                      className:
                                        "flex h-11 w-11 items-center justify-center rounded-full text-[#555a65] transition hover:bg-[#f3f1f6]",
                                      "aria-label": "分享课程",
                                      children: jsxRuntime.jsx(iy, {
                                        "code-path":
                                          "src\\pages\\CourseDetail.tsx:163:19",
                                        className: "h-5 w-5",
                                      }),
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            jsxRuntime.jsxs("div", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:168:13",
                              className: "pt-8",
                              children: [
                                jsxRuntime.jsx("p", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:169:15",
                                  className: "text-xs font-bold text-[#9a9da6]",
                                  children: "课程目录",
                                }),
                                jsxRuntime.jsxs("div", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:170:15",
                                  className:
                                    "mt-2 flex items-center justify-between gap-5",
                                  children: [
                                    jsxRuntime.jsxs("h2", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:171:17",
                                      className:
                                        "text-2xl font-black text-[#111318]",
                                      children: "已上架章节",
                                    }),
                                    jsxRuntime.jsxs("span", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:172:17",
                                      className:
                                        "shrink-0 text-sm font-bold text-[#737783]",
                                      children: [h.done, "/", h.total, " 课"],
                                    }),
                                  ],
                                }),
                                jsxRuntime.jsx("p", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:174:15",
                                  className:
                                    "mt-4 text-sm font-semibold leading-7 text-[#777b85]",
                                  children: "选择章节，按需要阅读讲义、查看幻灯片或完成测验。",
                                }),
                                jsxRuntime.jsx("div", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:176:15",
                                  className: "mt-7 space-y-4",
                                  children: n.chapters.map((O, P) => {
                                    const G = P === y;
                                    return jsxRuntime.jsxs(
                                      "button",
                                      {
                                        "code-path":
                                          "src\\pages\\CourseDetail.tsx:180:21",
                                        type: "button",
                                        onClick: () => R(P),
                                        className: `relative flex min-h-[82px] w-full items-center gap-4 rounded-2xl bg-white px-5 text-left transition ${G ? "border-[3px] border-[#6038ef] shadow-[0_7px_22px_rgba(96,56,239,0.08)]" : "border border-black/[0.09] hover:border-[#6c0ef2]/35 hover:shadow-sm"}`,
                                        children: [
                                          jsxRuntime.jsx("span", {
                                            "code-path":
                                              "src\\pages\\CourseDetail.tsx:190:23",
                                            className: `flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${O.done ? "bg-[#eaf8ed] text-[#25ad4d]" : G ? "bg-[#efeaff] text-[#6038ef]" : "bg-[#f4f5f7] text-[#737783]"}`,
                                            children: O.done
                                              ? jsxRuntime.jsx(Dm, {
                                                  "code-path":
                                                    "src\\pages\\CourseDetail.tsx:191:41",
                                                  className: "h-6 w-6",
                                                  strokeWidth: 3,
                                                })
                                              : jsxRuntime.jsx(Om, {
                                                  "code-path":
                                                    "src\\pages\\CourseDetail.tsx:191:89",
                                                  className:
                                                    "h-5 w-5 fill-current",
                                                }),
                                          }),
                                          jsxRuntime.jsxs("span", {
                                            "code-path":
                                              "src\\pages\\CourseDetail.tsx:193:23",
                                            className: "min-w-0 flex-1",
                                            children: [
                                              jsxRuntime.jsx("span", {
                                                "code-path":
                                                  "src\\pages\\CourseDetail.tsx:194:25",
                                                className:
                                                  "block text-base font-black text-[#111318]",
                                                children: O.title,
                                              }),
                                              jsxRuntime.jsxs("span", {
                                                "code-path":
                                                  "src\\pages\\CourseDetail.tsx:195:25",
                                                className:
                                                  "mt-1 block text-xs font-semibold text-[#989ba4]",
                                                children: [
                                                  "课程 ",
                                                  O.orderNo ?? P + 1,
                                                  " · ",
                                                  RESOURCE_OPTIONS.filter((item) => resourceTypes(O).includes(item.type)).map((item) => item.label).join(" / "),
                                                ],
                                              }),
                                            ],
                                          }),
                                          jsxRuntime.jsx("span", {
                                            "code-path":
                                              "src\\pages\\CourseDetail.tsx:197:23",
                                            className:
                                              "shrink-0 text-sm font-bold text-[#8a8e98]",
                                            children: O.done
                                              ? "已完成"
                                              : "开始学习",
                                          }),
                                        ],
                                      },
                                      O.title,
                                    );
                                  }),
                                }),
                              ],
                            }),
                          ],
                        }),
                        jsxRuntime.jsxs("aside", {
                          "code-path": "src\\pages\\CourseDetail.tsx:205:11",
                          className:
                            "sticky top-[112px] overflow-hidden rounded-2xl border border-black/[0.10] bg-white p-2 shadow-[0_8px_30px_rgba(17,19,24,0.04)]",
                          children: [
                            jsxRuntime.jsx("div", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:206:13",
                              className:
                                "flex h-[276px] items-center justify-center rounded-xl border border-black/[0.08] bg-[radial-gradient(circle_at_50%_45%,#fff_0%,#fafafa_65%,#f4f5f6_100%)]",
                              children: jsxRuntime.jsx("img", {
                                "code-path":
                                  "src\\pages\\CourseDetail.tsx:207:15",
                                src: n.icon,
                                alt: n.name,
                                className: "h-[76%] w-[76%] object-contain",
                              }),
                            }),
                            jsxRuntime.jsxs("div", {
                              "code-path":
                                "src\\pages\\CourseDetail.tsx:209:13",
                              className: "px-4 pb-4 pt-5",
                              children: [
                                jsxRuntime.jsx("h2", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:210:15",
                                  className:
                                    "text-lg font-black text-[#111318]",
                                  children: "课程进度",
                                }),
                                jsxRuntime.jsx("p", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:211:15",
                                  className:
                                    "mt-3 text-sm font-semibold leading-7 text-[#7c808b]",
                                  children:
                                    "按照课程章节逐步学习，完成全部内容并掌握核心知识。",
                                }),
                                jsxRuntime.jsxs("div", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:214:15",
                                  className: "mt-6 flex items-center gap-3",
                                  children: [
                                    jsxRuntime.jsx("div", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:215:17",
                                      className:
                                        "h-2 flex-1 overflow-hidden rounded-full bg-[#ececf0]",
                                      children: jsxRuntime.jsx("div", {
                                        "code-path":
                                          "src\\pages\\CourseDetail.tsx:216:19",
                                        className:
                                          "h-full rounded-full bg-[#6038ef] transition-all",
                                        style: { width: `${h.percent}%` },
                                      }),
                                    }),
                                    jsxRuntime.jsxs("span", {
                                      "code-path":
                                        "src\\pages\\CourseDetail.tsx:218:17",
                                      className:
                                        "shrink-0 text-sm font-bold text-[#737783]",
                                      children: ["已完成 ", h.percent, "%"],
                                    }),
                                  ],
                                }),
                                jsxRuntime.jsx("button", {
                                  "code-path":
                                    "src\\pages\\CourseDetail.tsx:220:15",
                                  type: "button",
                                  onClick: () => R(j),
                                  className:
                                    "mt-6 w-full rounded-xl bg-[#6038ef] py-3.5 text-base font-black text-white shadow-[0_7px_20px_rgba(96,56,239,0.22)] transition hover:bg-[#512bdc]",
                                  children: "继续学习",
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                z !== null &&
                  jsxRuntime.jsx(LessonStartModal, {
                    "code-path": "src\\pages\\CourseDetail.tsx:233:9",
                    course: n,
                    lessonTitle: n.chapters[z].title,
                    lessonIndex: z,
                    onClose: () => R(null),
                    onSelectResource: (mode) => {
                      if (mode === "quiz") $(z);
                      else if (mode === "presentation") Q(z);
                      else E(z);
                      R(null);
                    },
                  }),
              ],
            });
}

const vx = "zhixun-course-favorites";

function a3() {
  try {
    const n = JSON.parse(localStorage.getItem(vx) ?? "[]");
    return new Set(Array.isArray(n) ? n : []);
  } catch {
    return new Set();
  }
}

function Bookmarks({ onNavigate: n, onOpenBookmark: o }) {
  const learning = useLearning();
  const [r, u] = React.useState("courses"),
    [i, d] = React.useState(pu),
    [p, m] = React.useState(a3),
    b = React.useMemo(() => $t.filter((y) => p.has(y.id)), [p]),
    practiceBookmarks = React.useMemo(() => i.filter((item) => item.resourceKind === "bank" || String(item.id).startsWith("quiz-")), [i]),
    noteBookmarks = React.useMemo(() => i.filter((item) => item.resourceKind !== "bank" && !String(item.id).startsWith("quiz-")), [i]),
    h = (y) => {
      d((j) => {
        const z = j.filter((R) => R.id !== y);
        return (hu(z), z);
      });
    },
    x = (y) => {
      m((j) => {
        const z = new Set(j);
        return (
          z.delete(y),
          localStorage.setItem(vx, JSON.stringify([...z])),
          persistState({ favorites: [...z] }),
          z
        );
      });
    };
  React.useEffect(() => {
    if (Array.isArray(learning.data?.bookmarks)) {
      d((current) => JSON.stringify(current) === JSON.stringify(learning.data.bookmarks) ? current : learning.data.bookmarks);
    }
  }, [learning.data?.bookmarks]);
  React.useEffect(() => {
    if (!Array.isArray(learning.data?.favorites)) return;
    m((current) => {
      const next = new Set(learning.data.favorites);
      return current.size === next.size && [...current].every((id) => next.has(id)) ? current : next;
    });
  }, [learning.data?.favorites]);
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\pages\\Bookmarks.tsx:54:5",
    className: "min-h-screen bg-[#fbfbfd]",
    children: [
      jsxRuntime.jsx(AppNavigation, {
        "code-path": "src\\pages\\Bookmarks.tsx:55:7",
        active: "bookmarks",
        onNavigate: n,
      }),
      jsxRuntime.jsxs("main", {
        "code-path": "src\\pages\\Bookmarks.tsx:57:7",
        className: "mx-auto max-w-[1240px] px-5 pb-20 pt-8 sm:px-8",
        children: [
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\Bookmarks.tsx:58:9",
            className: "text-center",
            children: [
              jsxRuntime.jsx("h1", {
                "code-path": "src\\pages\\Bookmarks.tsx:59:11",
                className: "text-4xl font-black tracking-tight text-[#111318]",
                children: "收藏夹",
              }),
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\Bookmarks.tsx:60:11",
                className: "mt-2 font-semibold text-[#8a8e98]",
                children: "集中查看收藏课程、个人笔记和习题记录。",
              }),
              jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\Bookmarks.tsx:61:11",
                className:
                  "mt-5 inline-flex rounded-xl border border-black/[0.08] bg-white p-1 shadow-sm",
                children: [
                  jsxRuntime.jsx("button", {
                    "code-path": "src\\pages\\Bookmarks.tsx:69:13",
                    type: "button",
                    onClick: () => u("courses"),
                    className: `rounded-lg px-5 py-2 text-sm font-extrabold transition ${r === "courses" ? "bg-[#f0ebff] text-[#6038ef]" : "text-[#696d77] hover:bg-[#f6f6f8]"}`,
                    children: "课程",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    onClick: () => u("notes"),
                    className: `rounded-lg px-5 py-2 text-sm font-extrabold transition ${r === "notes" ? "bg-[#f0ebff] text-[#6038ef]" : "text-[#696d77] hover:bg-[#f6f6f8]"}`,
                    children: "笔记",
                  }),
                  jsxRuntime.jsx("button", {
                    "code-path": "src\\pages\\Bookmarks.tsx:62:13",
                    type: "button",
                    onClick: () => u("practice"),
                    className: `rounded-lg px-5 py-2 text-sm font-extrabold transition ${r === "practice" ? "bg-[#f0ebff] text-[#6038ef]" : "text-[#696d77] hover:bg-[#f6f6f8]"}`,
                    children: "习题",
                  }),
                ],
              }),
            ],
          }),
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\Bookmarks.tsx:79:9",
            className: "mt-7 border-t border-black/[0.07] pt-7",
            children: [
              r === "practice" &&
                (practiceBookmarks.length > 0
                  ? jsxRuntime.jsx("div", {
                      "code-path": "src\\pages\\Bookmarks.tsx:82:15",
                      className: "grid gap-4 lg:grid-cols-2",
                      children: practiceBookmarks.map((y) => {
                        const j = y.id.startsWith("quiz-");
                        const legacyQuestionIndex = Number.parseInt(String(y.id).split("-").pop(), 10);
                        const openQuestion = () => o?.({
                          view: "quiz",
                          courseId: y.courseId,
                          lessonIndex: y.lessonIndex ?? 0,
                          questionId: y.questionId,
                          questionIndex: y.questionIndex ?? (Number.isFinite(legacyQuestionIndex) ? legacyQuestionIndex : 0),
                        });
                        return jsxRuntime.jsx(
                          "article",
                          {
                            "code-path": "src\\pages\\Bookmarks.tsx:86:21",
                            className:
                              "group rounded-2xl border border-black/[0.08] bg-white p-6 shadow-[0_4px_18px_rgba(17,19,24,0.035)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(47,33,82,0.08)]",
                            role: "button",
                            tabIndex: 0,
                            onClick: openQuestion,
                            onKeyDown: (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openQuestion();
                              }
                            },
                            children: jsxRuntime.jsxs("div", {
                              "code-path": "src\\pages\\Bookmarks.tsx:87:23",
                              className:
                                "flex items-start justify-between gap-5",
                              children: [
                                jsxRuntime.jsxs("div", {
                                  "code-path":
                                    "src\\pages\\Bookmarks.tsx:88:25",
                                  className: "min-w-0 flex-1",
                                  children: [
                                    jsxRuntime.jsxs("div", {
                                      "code-path":
                                        "src\\pages\\Bookmarks.tsx:89:27",
                                      className:
                                        "flex flex-wrap items-center gap-2",
                                      children: [
                                        jsxRuntime.jsxs("span", {
                                          "code-path":
                                            "src\\pages\\Bookmarks.tsx:90:29",
                                          className: `inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-extrabold ${j ? "bg-[#fff0ed] text-[#e0523e]" : "bg-[#eef2ff] text-[#4b72cc]"}`,
                                          children: [
                                            j
                                              ? jsxRuntime.jsx(D2, {
                                                  "code-path":
                                                    "src\\pages\\Bookmarks.tsx:91:52",
                                                  className: "h-3.5 w-3.5",
                                                })
                                              : jsxRuntime.jsx($a, {
                                                  "code-path":
                                                    "src\\pages\\Bookmarks.tsx:91:95",
                                                  className: "h-3.5 w-3.5",
                                                }),
                                            j ? "题目解析" : "讲义段落",
                                          ],
                                        }),
                                        jsxRuntime.jsxs("span", {
                                          "code-path":
                                            "src\\pages\\Bookmarks.tsx:94:29",
                                          className:
                                            "text-xs font-bold text-[#9498a1]",
                                          children: [
                                            y.courseName,
                                            " · ",
                                            y.lessonTitle,
                                          ],
                                        }),
                                        jsxRuntime.jsx("span", {
                                          className: `rounded-full px-3 py-1 text-xs font-extrabold ${y.correct === true ? "bg-[#e9f8ed] text-[#23853a]" : y.correct === false ? "bg-[#fff0ed] text-[#d54b3a]" : "bg-[#f1f2f5] text-[#7b818c]"}`,
                                          children: y.correct === true ? "回答正确" : y.correct === false ? "回答错误" : "作答结果未记录",
                                        }),
                                      ],
                                    }),
                                    jsxRuntime.jsx("h2", {
                                      "code-path":
                                        "src\\pages\\Bookmarks.tsx:96:27",
                                      className:
                                        "mt-4 text-xl font-black text-[#111318]",
                                      children: y.question || y.heading || "收藏的题目",
                                    }),
                                    jsxRuntime.jsx("p", {
                                      "code-path":
                                        "src\\pages\\Bookmarks.tsx:97:27",
                                      className:
                                        "mt-3 line-clamp-4 text-sm font-semibold leading-7 text-[#676b76]",
                                      children: y.text || "点击卡片重新打开这道题。",
                                    }),
                                  ],
                                }),
                                jsxRuntime.jsx("button", {
                                  "code-path":
                                    "src\\pages\\Bookmarks.tsx:99:25",
                                  type: "button",
                                  onClick: (event) => { event.stopPropagation(); h(y.id); },
                                  className:
                                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8a8e98] transition hover:bg-[#fff0f0] hover:text-[#e34c4c]",
                                  "aria-label": "删除书签",
                                  children: jsxRuntime.jsx(my, {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:105:27",
                                    className: "h-5 w-5",
                                  }),
                                }),
                              ],
                            }),
                          },
                          y.id,
                        );
                      }),
                    })
                  : jsxRuntime.jsx(nm, {
                      "code-path": "src\\pages\\Bookmarks.tsx:113:15",
                      icon: jsxRuntime.jsx($a, {
                        "code-path": "src\\pages\\Bookmarks.tsx:114:23",
                        className: "h-10 w-10",
                      }),
                      title: "还没有收藏习题",
                      description:
                        "在章节测验的题目解析页点击书签，即可把单道题收藏到这里。",
                      action: "浏览课程",
                      onAction: () => n("courses"),
                    })),
              r === "courses" &&
                (b.length > 0
                  ? jsxRuntime.jsx("div", {
                      "code-path": "src\\pages\\Bookmarks.tsx:125:15",
                      className:
                        "grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                      children: b.map((y) => {
                        const j = bs(y);
                        return jsxRuntime.jsxs(
                          "article",
                          {
                            "code-path": "src\\pages\\Bookmarks.tsx:129:21",
                            className:
                              "group overflow-hidden rounded-2xl border border-black/[0.10] bg-white p-2 shadow-[0_3px_16px_rgba(17,19,24,0.035)] transition hover:-translate-y-1 hover:shadow-[0_16px_34px_rgba(49,31,87,0.10)]",
                            role: "button",
                            tabIndex: 0,
                            onClick: () => o?.({ view: "course", courseId: y.id }),
                            onKeyDown: (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                o?.({ view: "course", courseId: y.id });
                              }
                            },
                            children: [
                              jsxRuntime.jsxs("div", {
                                "code-path": "src\\pages\\Bookmarks.tsx:130:23",
                                className:
                                  "relative flex h-52 items-center justify-center rounded-xl border border-black/[0.07] bg-[radial-gradient(circle_at_50%_45%,#fff_0%,#f7f7f8_100%)]",
                                children: [
                                  jsxRuntime.jsx("img", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:131:25",
                                    src: y.icon,
                                    alt: y.name,
                                    className:
                                      "h-[72%] w-[72%] object-contain transition-transform group-hover:scale-105",
                                  }),
                                  jsxRuntime.jsx("button", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:132:25",
                                    type: "button",
                                    onClick: (event) => { event.stopPropagation(); x(y.id); },
                                    className:
                                      "absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-[#eee6ff] text-[#6038ef] transition hover:bg-[#e2d5ff]",
                                    "aria-label": `取消收藏${y.name}`,
                                    children: jsxRuntime.jsx(bn, {
                                      "code-path":
                                        "src\\pages\\Bookmarks.tsx:138:27",
                                      className: "h-5 w-5 fill-current",
                                    }),
                                  }),
                                ],
                              }),
                              jsxRuntime.jsxs("div", {
                                "code-path": "src\\pages\\Bookmarks.tsx:141:23",
                                className: "px-3 pb-3 pt-4",
                                children: [
                                  jsxRuntime.jsx("p", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:142:25",
                                    className:
                                      "text-xs font-semibold text-[#9a9da6]",
                                    children: "课程",
                                  }),
                                  jsxRuntime.jsx("h2", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:143:25",
                                    className:
                                      "mt-1 text-xl font-black text-[#111318]",
                                    children: y.name,
                                  }),
                                  jsxRuntime.jsx("p", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:144:25",
                                    className:
                                      "mt-3 line-clamp-2 min-h-[48px] text-sm font-semibold leading-6 text-[#747883]",
                                    children: y.description,
                                  }),
                                  jsxRuntime.jsxs("div", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:145:25",
                                    className: "mt-5 flex items-center gap-3",
                                    children: [
                                      jsxRuntime.jsx("div", {
                                        "code-path":
                                          "src\\pages\\Bookmarks.tsx:146:27",
                                        className:
                                          "h-1.5 flex-1 overflow-hidden rounded-full bg-[#ececf0]",
                                        children: jsxRuntime.jsx("div", {
                                          "code-path":
                                            "src\\pages\\Bookmarks.tsx:146:99",
                                          className:
                                            "h-full rounded-full bg-[#6038ef]",
                                          style: { width: `${j.percent}%` },
                                        }),
                                      }),
                                      jsxRuntime.jsxs("span", {
                                        "code-path":
                                          "src\\pages\\Bookmarks.tsx:147:27",
                                        className:
                                          "text-xs font-extrabold text-[#747883]",
                                        children: [j.percent, "%"],
                                      }),
                                    ],
                                  }),
                                  jsxRuntime.jsxs("div", {
                                    "code-path":
                                      "src\\pages\\Bookmarks.tsx:149:25",
                                    className:
                                      "mt-4 flex items-center justify-between border-t border-black/[0.06] pt-4 text-xs font-bold text-[#7d818b]",
                                    children: [
                                      jsxRuntime.jsxs("span", {
                                        "code-path":
                                          "src\\pages\\Bookmarks.tsx:150:27",
                                        className: "flex items-center gap-1.5",
                                        children: [
                                          jsxRuntime.jsx(nu, {
                                            "code-path":
                                              "src\\pages\\Bookmarks.tsx:150:71",
                                            className: "h-4 w-4",
                                          }),
                                          y.level,
                                        ],
                                      }),
                                      jsxRuntime.jsxs("span", {
                                        "code-path":
                                          "src\\pages\\Bookmarks.tsx:151:27",
                                        className: "flex items-center gap-1.5",
                                        children: [
                                          jsxRuntime.jsx(yl, {
                                            "code-path":
                                              "src\\pages\\Bookmarks.tsx:151:71",
                                            className: "h-4 w-4",
                                          }),
                                          y.duration,
                                          " 小时",
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          },
                          y.id,
                        );
                      }),
                    })
                  : jsxRuntime.jsx(nm, {
                      "code-path": "src\\pages\\Bookmarks.tsx:159:15",
                      icon: jsxRuntime.jsx(Lm, {
                        "code-path": "src\\pages\\Bookmarks.tsx:160:23",
                        className: "h-10 w-10",
                      }),
                      title: "还没有收藏课程",
                      description:
                        "点击课程卡片右上角的书签图标，即可在这里查看。",
                      action: "浏览课程",
                      onAction: () => n("courses"),
                    })),
              r === "notes" && (noteBookmarks.length > 0
                ? jsxRuntime.jsx("div", {
                    className: "grid gap-4 lg:grid-cols-2",
                    children: noteBookmarks.map((item) => jsxRuntime.jsxs("article", {
                      className: "group rounded-2xl border border-black/[0.08] bg-white p-6 shadow-[0_4px_18px_rgba(17,19,24,0.035)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(47,33,82,0.08)]",
                      role: "button",
                      tabIndex: 0,
                      onClick: () => o?.({ view: "lecture", courseId: item.courseId, lessonIndex: item.lessonIndex ?? 0, sectionId: item.sectionId }),
                      onKeyDown: (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          o?.({ view: "lecture", courseId: item.courseId, lessonIndex: item.lessonIndex ?? 0, sectionId: item.sectionId });
                        }
                      },
                      children: [
                        jsxRuntime.jsxs("div", { className: "flex items-start justify-between gap-5", children: [
                          jsxRuntime.jsxs("div", { className: "min-w-0 flex-1", children: [
                            jsxRuntime.jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
                              jsxRuntime.jsx("span", { className: "inline-flex items-center rounded-full bg-[#eef2ff] px-3 py-1 text-xs font-extrabold text-[#4b72cc]", children: "学习笔记" }),
                              jsxRuntime.jsxs("span", { className: "text-xs font-bold text-[#9498a1]", children: [item.courseName, " · ", item.lessonTitle] }),
                            ] }),
                            jsxRuntime.jsx("h2", { className: "mt-4 text-xl font-black text-[#111318]", children: item.heading || "重点摘录" }),
                            jsxRuntime.jsx("p", { className: "mt-3 line-clamp-4 text-sm font-semibold leading-7 text-[#676b76]", children: item.text }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              onClick: (event) => { event.stopPropagation(); o?.({ view: "lecture", courseId: item.courseId, lessonIndex: item.lessonIndex ?? 0, sectionId: item.sectionId }); },
                              className: "mt-3 rounded-lg border border-[#d8cff5] px-3 py-2 text-xs font-extrabold text-[#6038ef] hover:bg-[#f4efff]",
                              children: "打开讲义",
                            }),
                          ] }),
                          jsxRuntime.jsx("button", {
                            type: "button",
                            onClick: (event) => { event.stopPropagation(); h(item.id); },
                            className: "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#8a8e98] transition hover:bg-[#fff0f0] hover:text-[#e34c4c]",
                            "aria-label": "删除笔记",
                            children: jsxRuntime.jsx(my, { className: "h-5 w-5" }),
                          }),
                        ] }),
                      ],
                    }, item.id)),
                  })
                : jsxRuntime.jsx(nm, {
                    icon: jsxRuntime.jsx($a, { className: "h-10 w-10" }),
                    title: "还没有学习笔记",
                    description: "阅读讲义或实操时，点击“书签”即可把重点段落收进笔记。",
                    action: "浏览课程",
                    onAction: () => n("courses"),
                  })),
            ],
          }),
        ],
      }),
    ],
  });
}

function nm({ icon: n, title: r, description: u, action: i, onAction: d }) {
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\pages\\Bookmarks.tsx:188:5",
    className:
      "rounded-3xl border border-dashed border-black/[0.12] bg-white py-16 text-center",
    children: [
      jsxRuntime.jsx("div", {
        "code-path": "src\\pages\\Bookmarks.tsx:189:7",
        className:
          "mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f2effb] text-[#6038ef]",
        children: n,
      }),
      jsxRuntime.jsx("h2", {
        "code-path": "src\\pages\\Bookmarks.tsx:190:7",
        className: "mt-4 text-xl font-black text-[#111318]",
        children: r,
      }),
      jsxRuntime.jsx("p", {
        "code-path": "src\\pages\\Bookmarks.tsx:191:7",
        className: "mt-2 text-sm font-semibold text-[#8a8e98]",
        children: u,
      }),
      jsxRuntime.jsx("button", {
        "code-path": "src\\pages\\Bookmarks.tsx:192:7",
        type: "button",
        onClick: d,
        className:
          "mt-6 rounded-xl bg-[#6038ef] px-6 py-3 text-sm font-black text-white shadow-md",
        children: i,
      }),
    ],
  });
}

const wx = "zhixun-course-favorites";

function sm() {
  try {
    const n = JSON.parse(localStorage.getItem(wx) ?? "[]");
    return new Set(Array.isArray(n) ? n : []);
  } catch {
    return new Set();
  }
}

function l3({ course: n, favorite: r, onToggleFavorite: u, onOpen: i }) {
  return jsxRuntime.jsxs("article", {
    "code-path": "src\\pages\\Courses.tsx:32:5",
    onClick: i,
    onKeyDown: (d) => {
      (d.key === "Enter" || d.key === " ") && (d.preventDefault(), i());
    },
    role: "link",
    tabIndex: 0,
    "aria-label": `查看${n.name}课程详情`,
    className:
      "group flex min-h-[536px] cursor-pointer flex-col rounded-2xl border border-black/[0.12] bg-white p-2 shadow-[0_2px_12px_rgba(17,19,24,0.025)] outline-none transition-all duration-300 hover:-translate-y-1 hover:border-[#6c0ef2]/25 hover:shadow-[0_16px_38px_rgba(54,25,92,0.10)] focus-visible:ring-2 focus-visible:ring-[#6c0ef2] focus-visible:ring-offset-2",
    children: [
      jsxRuntime.jsxs("div", {
        "code-path": "src\\pages\\Courses.tsx:45:7",
        className:
          "relative flex h-[292px] items-center justify-center overflow-hidden rounded-[13px] border border-black/[0.09] bg-[radial-gradient(circle_at_50%_45%,#ffffff_0%,#fbfbfb_55%,#f5f6f7_100%)]",
        children: [
          jsxRuntime.jsx("img", {
            "code-path": "src\\pages\\Courses.tsx:46:9",
            src: n.icon,
            alt: "",
            className:
              "h-[76%] w-[76%] object-contain transition-transform duration-300 group-hover:scale-[1.035]",
          }),
          jsxRuntime.jsx("button", {
            "code-path": "src\\pages\\Courses.tsx:51:9",
            type: "button",
            onClick: (d) => {
              (d.stopPropagation(), u());
            },
            className: `absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6c0ef2] focus-visible:ring-offset-2 ${r ? "bg-[#f0e6ff] text-[#6c0ef2]" : "bg-white/70 text-[#686d78] hover:bg-[#f0e6ff] hover:text-[#6c0ef2]"}`,
            "aria-label": r ? `取消收藏${n.name}` : `收藏${n.name}`,
            "aria-pressed": r,
            title: r ? "取消收藏" : "收藏课程",
            children: jsxRuntime.jsx(bn, {
              "code-path": "src\\pages\\Courses.tsx:66:11",
              className: `h-[21px] w-[21px] ${r ? "fill-current" : ""}`,
              strokeWidth: 2.2,
            }),
          }),
        ],
      }),
      jsxRuntime.jsxs("div", {
        "code-path": "src\\pages\\Courses.tsx:70:7",
        className: "flex flex-1 flex-col px-3 pb-2 pt-4",
        children: [
          jsxRuntime.jsx("p", {
            "code-path": "src\\pages\\Courses.tsx:71:9",
            className: "text-xs font-semibold text-[#a0a3aa]",
            children: "课程",
          }),
          jsxRuntime.jsx("h2", {
            "code-path": "src\\pages\\Courses.tsx:72:9",
            className:
              "mt-1.5 text-xl font-black tracking-tight text-[#111318]",
            children: n.name,
          }),
          jsxRuntime.jsx("p", {
            "code-path": "src\\pages\\Courses.tsx:73:9",
            className:
              "mt-4 min-h-[52px] text-sm font-semibold leading-[1.75] text-[#747883]",
            children: n.description,
          }),
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\Courses.tsx:77:9",
            className:
              "mt-auto flex items-center justify-between border-t border-black/[0.07] pt-4 text-[13px] font-semibold text-[#747883]",
            children: [
              jsxRuntime.jsxs("span", {
                "code-path": "src\\pages\\Courses.tsx:78:11",
                className: "flex items-center gap-2",
                children: [
                  jsxRuntime.jsx(nu, {
                    "code-path": "src\\pages\\Courses.tsx:79:13",
                    className: "h-[18px] w-[18px]",
                    strokeWidth: 1.9,
                  }),
                  n.level,
                ],
              }),
              jsxRuntime.jsxs("span", {
                "code-path": "src\\pages\\Courses.tsx:82:11",
                className: "flex items-center gap-2",
                children: [
                  jsxRuntime.jsx(yl, {
                    "code-path": "src\\pages\\Courses.tsx:83:13",
                    className: "h-[18px] w-[18px]",
                    strokeWidth: 1.9,
                  }),
                  n.duration,
                  " 小时",
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function Courses({
  onNavigate: n,
  initialCourseId: r,
  initialLectureIndex: u,
  initialPresentationIndex: i,
  initialQuizIndex: d,
}) {
  const learning = useLearning();
  const [p, m] = React.useState(sm),
    [b, h] = React.useState(""),
    [x, y] = React.useState(null),
    [j, z] = React.useState(() => $t.find((B) => B.id === r) ?? null),
    [R, N] = React.useState(!1);
  React.useEffect(() => {
    if (!Array.isArray(learning.data?.favorites)) return;
    m((current) => {
      const next = new Set(learning.data.favorites);
      return current.size === next.size && [...current].every((id) => next.has(id)) ? current : next;
    });
  }, [learning.data?.favorites]);
  React.useEffect(() => {
    localStorage.setItem(wx, JSON.stringify([...p]));
    persistState({ favorites: [...p] });
  }, [p]);
  const E = React.useMemo(() => {
      const B = b.trim().toLocaleLowerCase();
      return B
        ? $t.filter((Q) =>
            `${Q.name}${Q.description}${Q.level}`
              .toLocaleLowerCase()
              .includes(B),
          )
        : $t;
    }, [b, learning.data?.courses]),
    _ = (B) => {
      m((Q) => {
        const H = new Set(Q);
        return (H.has(B) ? H.delete(B) : H.add(B), H);
      });
    },
    M = (B) => {
      if (B && typeof B === "object") {
        n(B);
        return;
      }
      if (B === "courses") {
        (N(!1), m(sm()), z(null), y(null), h(""));
        return;
      }
      if (B === "bookmarks") {
        (N(!0), z(null), y(null));
        return;
      }
      n(B);
    };
  return R
    ? jsxRuntime.jsx(Bookmarks, {
        "code-path": "src\\pages\\Courses.tsx:153:12",
        onNavigate: M,
        onOpenBookmark: M,
      })
    : x
      ? jsxRuntime.jsx(zs, {
          "code-path": "src\\pages\\Courses.tsx:158:7",
          onComplete: () => {
            (z(x), y(null), window.scrollTo({ top: 0, behavior: "instant" }));
          },
        })
      : j
        ? jsxRuntime.jsx(CourseDetail, {
            "code-path": "src\\pages\\Courses.tsx:170:7",
            course: $t.find((course) => course.id === j.id) ?? j,
            favorite: p.has(j.id),
            onToggleFavorite: () => _(j.id),
            onNavigate: M,
            onBack: () => z(null),
            initialLectureIndex: u,
            initialPresentationIndex: i,
            initialQuizIndex: d,
          })
        : jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\Courses.tsx:184:5",
            className: "min-h-screen bg-[#fbfbfc]",
            children: [
              jsxRuntime.jsx(AppNavigation, {
                "code-path": "src\\pages\\Courses.tsx:185:7",
                active: "courses",
                onNavigate: M,
                searchValue: b,
                onSearchChange: h,
              }),
              jsxRuntime.jsxs("main", {
                "code-path": "src\\pages\\Courses.tsx:192:7",
                className:
                  "mx-auto max-w-[1680px] px-5 pb-20 pt-7 sm:px-8 sm:pt-9",
                children: [
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\Courses.tsx:193:9",
                    className: "text-center",
                    children: [
                      jsxRuntime.jsx("h1", {
                        "code-path": "src\\pages\\Courses.tsx:194:11",
                        className:
                          "text-3xl font-black tracking-tight text-[#111318] sm:text-[34px]",
                        children: "课程",
                      }),
                      jsxRuntime.jsx("p", {
                        "code-path": "src\\pages\\Courses.tsx:195:11",
                        className:
                          "mt-2 text-sm font-semibold text-[#8b8f99] sm:text-base",
                        children:
                          "通过互动式、实践性强的专业课程提升您的技能。",
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("label", {
                    "code-path": "src\\pages\\Courses.tsx:200:9",
                    className:
                      "mx-auto mt-6 flex h-11 max-w-xl items-center gap-2.5 rounded-xl border border-black/10 bg-white px-4 focus-within:border-[#6c0ef2]/40 focus-within:ring-4 focus-within:ring-[#6c0ef2]/5 lg:hidden",
                    children: [
                      jsxRuntime.jsx(Vi, {
                        "code-path": "src\\pages\\Courses.tsx:201:11",
                        className: "h-5 w-5 text-[#747985]",
                      }),
                      jsxRuntime.jsx("input", {
                        "code-path": "src\\pages\\Courses.tsx:202:11",
                        value: b,
                        onChange: (B) => h(B.target.value),
                        placeholder: "搜索课程",
                        className:
                          "w-full bg-transparent text-sm font-semibold outline-none placeholder:text-[#9a9da6]",
                      }),
                    ],
                  }),
                  E.length > 0
                    ? jsxRuntime.jsx("section", {
                        "code-path": "src\\pages\\Courses.tsx:211:11",
                        className:
                          "mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
                        "aria-label": "课程列表",
                        children: E.map((B) =>
                          jsxRuntime.jsx(
                            l3,
                            {
                              "code-path": "src\\pages\\Courses.tsx:213:15",
                              course: B,
                              favorite: p.has(B.id),
                              onToggleFavorite: () => _(B.id),
                              onOpen: () => y(B),
                            },
                            B.id,
                          ),
                        ),
                      })
                    : jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\Courses.tsx:223:11",
                        className:
                          "mx-auto mt-20 max-w-md rounded-2xl border border-dashed border-black/15 bg-white px-6 py-12 text-center",
                        children: [
                          jsxRuntime.jsx(Vi, {
                            "code-path": "src\\pages\\Courses.tsx:224:13",
                            className: "mx-auto h-8 w-8 text-[#a0a3aa]",
                          }),
                          jsxRuntime.jsx("p", {
                            "code-path": "src\\pages\\Courses.tsx:225:13",
                            className: "mt-3 font-extrabold text-[#111318]",
                            children: "没有找到相关课程",
                          }),
                          jsxRuntime.jsx("p", {
                            "code-path": "src\\pages\\Courses.tsx:226:13",
                            className:
                              "mt-1 text-sm font-semibold text-[#8b8f99]",
                            children: "试试搜索其他课程名称或难度",
                          }),
                        ],
                      }),
                ],
              }),
            ],
          });
}

const n3 = [
    [290, 62],
    [108, 150],
    [510, 150],
    [790, 150],
    [195, 285],
    [415, 270],
    [585, 270],
    [700, 265],
    [875, 265],
    [655, 390],
    [820, 390],
    [945, 390],
  ],
  s3 = [
    { from: 0, to: 1 },
    { from: 0, to: 2 },
    { from: 1, to: 4 },
    { from: 2, to: 3 },
    { from: 2, to: 5 },
    { from: 2, to: 6 },
    { from: 3, to: 7 },
    { from: 3, to: 8 },
    { from: 7, to: 9 },
    { from: 8, to: 10 },
    { from: 8, to: 11 },
  ],
  o3 = {
    co: [
      "计算机系统概述",
      "数据的机器级表示",
      "存储器层次结构",
      "指令系统与 CPU",
      "运算方法与运算器",
      "Cache 工作原理",
      "虚拟存储器",
      "流水线基础",
      "总线与输入输出",
      "性能评价",
      "中断与 DMA",
      "多核处理器",
    ],
    ds: [
      "数据结构概述",
      "线性表",
      "树与二叉树",
      "图结构",
      "栈与队列",
      "查找算法",
      "排序算法",
      "树的遍历",
      "最短路径",
      "算法复杂度",
      "哈希表",
      "综合应用",
    ],
    os: [
      "操作系统概述",
      "进程与线程",
      "内存管理",
      "文件系统",
      "处理机调度",
      "虚拟内存",
      "页面置换",
      "文件组织",
      "设备管理",
      "死锁处理",
      "IO 系统",
      "系统安全",
    ],
    cn: [
      "网络体系结构",
      "物理层基础",
      "网络层与 IP",
      "传输层协议",
      "数据链路层",
      "路由算法",
      "子网划分",
      "TCP 可靠传输",
      "应用层协议",
      "拥塞控制",
      "DNS 服务",
      "网络安全",
    ],
    agent: [
      "智能体概述",
      "感知与环境",
      "规划与推理",
      "多智能体协作",
      "工具调用",
      "短期记忆",
      "长期记忆",
      "任务分解",
      "角色协作",
      "反思机制",
      "冲突解决",
      "智能体评测",
    ],
  },
  c3 = {
    co: [85, 82, 58, 32, 76, 45, 52, 28, 25, null, null, null],
    ds: [91, 86, 72, 43, 80, 68, 61, 55, 38, 74, null, null],
    os: [88, 79, 64, 35, 73, 57, 49, 41, 33, 29, null, null],
    cn: [84, 77, 62, 39, 71, 53, 47, 44, 36, 31, null, null],
    agent: [90, 83, 69, 46, 78, 62, 55, 51, 42, 37, null, null],
  };

function r3(n) {
  return n === null
    ? { fill: "#aeb3bd", light: "#eef0f3", stroke: "#d7dbe2" }
    : n >= 70
      ? { fill: "#6541dd", light: "#eee9ff", stroke: "#c9bcff" }
      : n >= 40
        ? { fill: "#10b9ad", light: "#ddfaf7", stroke: "#92e5df" }
        : { fill: "#ff765f", light: "#fff0ed", stroke: "#ffc2b8" };
}

function i3({ course: n, node: r, onClose: u, onReview: i, onRetest: d }) {
  return jsxRuntime.jsx("div", {
    "code-path": "src\\pages\\LearningProgress.tsx:70:5",
    className:
      "fixed inset-0 z-[100] flex items-center justify-center bg-[#30313a]/40 px-5 backdrop-blur-[1px]",
    onMouseDown: (p) => p.target === p.currentTarget && u(),
    children: jsxRuntime.jsxs("section", {
      "code-path": "src\\pages\\LearningProgress.tsx:71:7",
      className:
        "relative mt-12 w-full max-w-[420px] rounded-[22px] bg-white px-4 pb-5 pt-[82px] text-center shadow-[0_28px_80px_rgba(14,13,20,0.28)]",
      role: "dialog",
      "aria-modal": "true",
      children: [
        jsxRuntime.jsx("div", {
          "code-path": "src\\pages\\LearningProgress.tsx:72:9",
          className:
            "absolute left-1/2 top-0 flex h-[124px] w-[124px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#f7f7f8] shadow-[0_12px_34px_rgba(17,19,24,0.08)] ring-[10px] ring-white",
          children: jsxRuntime.jsx("img", {
            "code-path": "src\\pages\\LearningProgress.tsx:73:11",
            src: n.icon,
            alt: n.name,
            className: "h-[86px] w-[86px] object-contain",
          }),
        }),
        jsxRuntime.jsx("button", {
          "code-path": "src\\pages\\LearningProgress.tsx:75:9",
          type: "button",
          onClick: u,
          className:
            "absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-[#696d77] hover:bg-[#f2f2f4]",
          "aria-label": "关闭",
          children: jsxRuntime.jsx(uc, {
            "code-path": "src\\pages\\LearningProgress.tsx:75:188",
            className: "h-5 w-5",
          }),
        }),
        jsxRuntime.jsxs("p", {
          "code-path": "src\\pages\\LearningProgress.tsx:76:9",
          className: "text-xs font-extrabold text-[#8c909a]",
          children: [n.name, " · 知识点"],
        }),
        jsxRuntime.jsx("h2", {
          "code-path": "src\\pages\\LearningProgress.tsx:77:9",
          className: "mt-2 text-2xl font-black text-[#111318]",
          children: r.label,
        }),
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\LearningProgress.tsx:78:9",
          className:
            "mt-3 flex items-center justify-center gap-4 text-sm font-semibold text-[#747883]",
          children: [
            jsxRuntime.jsxs("span", {
              "code-path": "src\\pages\\LearningProgress.tsx:79:11",
              className: "flex items-center gap-1.5",
              children: [
                jsxRuntime.jsx(yl, {
                  "code-path": "src\\pages\\LearningProgress.tsx:79:55",
                  className: "h-4 w-4",
                }),
                "约 15 分钟",
              ],
            }),
            jsxRuntime.jsxs("span", {
              "code-path": "src\\pages\\LearningProgress.tsx:80:11",
              className: "font-extrabold text-[#6038ef]",
              children: [
                "正确率 ",
                r.accuracy === null ? "未测试" : `${r.accuracy}%`,
              ],
            }),
          ],
        }),
        jsxRuntime.jsx("p", {
          "code-path": "src\\pages\\LearningProgress.tsx:82:9",
          className:
            "mx-auto mt-4 max-w-xs text-sm font-semibold leading-6 text-[#7b7f89]",
          children: "选择一种方式复习知识点，完成后可重新测试并提高正确率。",
        }),
        jsxRuntime.jsxs("div", {
          "code-path": "src\\pages\\LearningProgress.tsx:83:9",
          className: "mt-6 border-t border-black/[0.07] pt-4",
          children: [
            jsxRuntime.jsxs("button", {
              "code-path": "src\\pages\\LearningProgress.tsx:84:11",
              type: "button",
              onClick: () => i("presentation"),
              className:
                "flex w-full items-center justify-center gap-2 rounded-xl bg-[#5f38ef] py-3.5 text-base font-black text-white shadow-[0_7px_20px_rgba(95,56,239,0.24)] hover:bg-[#512bdc]",
              children: [
                jsxRuntime.jsx(A2, {
                  "code-path": "src\\pages\\LearningProgress.tsx:84:255",
                  className: "h-5 w-5",
                }),
                "PPT 讲解",
              ],
            }),
            jsxRuntime.jsxs("button", {
              "code-path": "src\\pages\\LearningProgress.tsx:85:11",
              type: "button",
              onClick: () => i("lecture"),
              className:
                "mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-base font-extrabold text-[#666a75] hover:bg-[#f6f5f8] hover:text-[#5f38ef]",
              children: [
                jsxRuntime.jsx($a, {
                  "code-path": "src\\pages\\LearningProgress.tsx:85:230",
                  className: "h-5 w-5",
                }),
                "阅读讲义",
              ],
            }),
            jsxRuntime.jsxs("button", {
              "code-path": "src\\pages\\LearningProgress.tsx:86:11",
              type: "button",
              onClick: d,
              className:
                "mt-1 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-extrabold text-[#8a8e98] hover:text-[#6038ef]",
              children: [
                jsxRuntime.jsx(sy, {
                  "code-path": "src\\pages\\LearningProgress.tsx:86:192",
                  className: "h-4 w-4",
                }),
                "重新测试",
              ],
            }),
          ],
        }),
      ],
    }),
  });
}

function memoryText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(memoryText).filter(Boolean).join("、");
  if (typeof value === "object") return Object.values(value).map(memoryText).filter(Boolean).join("、");
  return String(value);
}

function MemoryTags({ items, empty = "等待学习记录" }) {
  const values = Array.isArray(items) ? items.map(memoryText).filter(Boolean).slice(0, 8) : [];
  if (!values.length) return jsxRuntime.jsx("span", { className: "zx-memory-empty", children: empty });
  return jsxRuntime.jsx("div", { className: "zx-memory-tags", children: values.map((value, index) =>
    jsxRuntime.jsx("span", { children: value }, `${value}-${index}`)
  ) });
}

function MemoryFacts({ value, labels = {} }) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  const visible = entries.filter(([, item]) => memoryText(item)).slice(0, 6);
  if (!visible.length) return jsxRuntime.jsx("span", { className: "zx-memory-empty", children: "暂无结构化记录" });
  return jsxRuntime.jsx("dl", { className: "zx-memory-facts", children: visible.map(([key, item]) =>
    jsxRuntime.jsxs("div", { children: [
      jsxRuntime.jsx("dt", { children: labels[key] || key }),
      jsxRuntime.jsx("dd", { children: memoryText(item) }),
    ] }, key)
  ) });
}

function LearnerMemoryCard({ memory, onSaved }) {
  const [customMemory, setCustomMemory] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [statusError, setStatusError] = React.useState(false);
  const [planBusy, setPlanBusy] = React.useState(false);
  const [planError, setPlanError] = React.useState("");
  React.useEffect(() => {
    setCustomMemory(memory?.userCustomMemory || "");
  }, [memory?.userCustomMemory]);
  const regeneratePlan = async () => {
    if (planBusy) return;
    setPlanBusy(true);
    setPlanError("");
    try {
      const result = await generateLearningPlan();
      onSaved?.(result?.memory || (await getLearnerMemory()));
    } catch (error) {
      setPlanError(error.message || "学习计划生成失败，请稍后重试");
    } finally {
      setPlanBusy(false);
    }
  };
  const saveCustomMemory = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setStatus("");
    setStatusError(false);
    try {
      const saved = await updateLearnerCustomMemory(customMemory.trim());
      onSaved?.(saved);
      setStatus("长期记忆已保存，Agent 下次回复会立即使用。");
    } catch (error) {
      setStatusError(true);
      setStatus(error.message || "长期记忆保存失败");
    } finally {
      setSaving(false);
    }
  };
  return jsxRuntime.jsxs("section", {
    className: "zx-memory-card",
    children: [
      jsxRuntime.jsxs("header", { className: "zx-memory-hero", children: [
        jsxRuntime.jsxs("div", { className: "zx-memory-hero-copy", children: [
          jsxRuntime.jsx("div", { className: "zx-memory-card-mark", children: "L" }),
          jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("h2", { children: "学习画像" }),
            jsxRuntime.jsx("p", { children: "用于个性化 Agent 回复。" }),
          ] }),
        ] }),
        jsxRuntime.jsxs("div", { className: "zx-memory-meta", children: [
          jsxRuntime.jsx("span", { children: `记忆版本 v${memory?.memoryVersion || 1}` }),
          jsxRuntime.jsx("span", { children: memory?.updatedAt ? `更新于 ${memory.updatedAt}` : "等待首次更新" }),
        ] }),
      ] }),
      jsxRuntime.jsxs("div", { className: "zx-memory-layout", children: [
        jsxRuntime.jsxs("div", { className: "zx-memory-content", children: [
          jsxRuntime.jsxs("section", { className: "zx-memory-panel zx-memory-summary-panel", children: [
            jsxRuntime.jsx("h3", { children: "学习概况" }),
            jsxRuntime.jsx("p", { className: "zx-memory-summary", children: memory?.profileSummary || "尚未形成画像摘要。完成资料填写并开始学习后，Lumin 会逐步补充。" }),
          ] }),
          jsxRuntime.jsx(LearningPlanPanel, {
            plan: memory?.learningPlan || null,
            generatedAt: memory?.planGeneratedAt || "",
            model: memory?.planModel || "",
            busy: planBusy,
            error: planError,
            onRegenerate: regeneratePlan,
          }),
          jsxRuntime.jsxs("div", { className: "zx-memory-panel-grid", children: [
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "学习目标" }),
              jsxRuntime.jsx(MemoryTags, { items: memory?.learningGoals, empty: "还没有明确目标" }),
            ] }),
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "当前关注" }),
              jsxRuntime.jsx(MemoryTags, { items: memory?.activeTopics, empty: "等待关注主题" }),
            ] }),
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "知识基础" }),
              jsxRuntime.jsx(MemoryFacts, { value: memory?.knowledgeLevel, labels: { selfReportedLevel: "自评阶段", basis: "依据" } }),
            ] }),
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "学习偏好" }),
              jsxRuntime.jsx(MemoryFacts, { value: memory?.preferences, labels: { language: "语言", responseStyle: "讲解方式", basis: "依据" } }),
            ] }),
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "已确认优势" }),
              jsxRuntime.jsx(MemoryTags, { items: memory?.strengths, empty: "暂无足够学习证据" }),
            ] }),
            jsxRuntime.jsxs("section", { className: "zx-memory-panel", children: [
              jsxRuntime.jsx("h3", { children: "待加强" }),
              jsxRuntime.jsx(MemoryTags, { items: memory?.weaknesses, empty: "暂无薄弱项记录" }),
            ] }),
          ] }),
        ] }),
        jsxRuntime.jsxs("aside", { className: "zx-memory-custom", children: [
          jsxRuntime.jsx("h3", { children: "长期记忆" }),
          jsxRuntime.jsx("p", { children: "Agent 每次回复都会参考这里的内容。" }),
          jsxRuntime.jsx("form", { onSubmit: saveCustomMemory, children: [
            jsxRuntime.jsx("label", { htmlFor: "zx-custom-memory", children: "自定义内容" }),
            jsxRuntime.jsx("textarea", {
              id: "zx-custom-memory",
              value: customMemory,
              maxLength: 4000,
              onChange: (event) => setCustomMemory(event.target.value),
              placeholder: "例如：讲解代码时先给结论；我正在准备智能体竞赛…",
              rows: 6,
            }),
            jsxRuntime.jsxs("div", { className: "zx-memory-form-foot", children: [
              jsxRuntime.jsx("span", { children: `${customMemory.length}/4000` }),
              jsxRuntime.jsx("button", { type: "submit", disabled: saving, children: saving ? "保存中…" : "保存长期记忆" }),
            ] }),
          ] }),
          status ? jsxRuntime.jsx("p", { className: `zx-memory-save-status${statusError ? " is-error" : ""}`, role: "status", children: status }) : null,
        ] }),
      ] }),
    ],
  });
}

function LearningProgress(props) {
  const [memory, setMemory] = React.useState(null);
  React.useEffect(() => {
    let active = true;
    getLearnerMemory()
      .then((value) => { if (active) setMemory(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  const tracked = $t.some((course) => o3[course.id] !== void 0);
  const hasMemory = Boolean(memory?.profileSummary);
  if (!tracked) {
    return <div className="min-h-screen bg-[#f7f7fa]">
      <AppNavigation active="progress" onNavigate={props.onNavigate} />
      <main className="zx-memory-page-main mx-auto flex w-full flex-col items-center gap-4 px-6 py-14 text-center">
        <h1 className="text-2xl font-extrabold text-[#111318]">{$t.length === 0 ? "还没有已发布的课程" : hasMemory ? "我的画像" : "暂无画像记忆"}</h1>
        <p className="text-sm font-semibold leading-7 text-[#8b8f99]">{$t.length === 0
          ? "管理员发布课程后，Lumin 会开始建立你的学习画像。"
          : hasMemory
            ? "目标、偏好与长期记忆。"
            : "开始学习后，Lumin 会逐步完善这里。"}</p>
        <div className="w-full text-left"><LearnerMemoryCard memory={memory} onSaved={setMemory} /></div>
        <div className="mt-3 flex flex-wrap justify-center gap-3">
          <button type="button" className="rounded-xl bg-[#6038ef] px-6 py-3 font-bold text-white" onClick={() => props.onNavigate?.("courses")}>查看课程</button>
          <button type="button" className="rounded-xl border border-[#e3dcec] bg-white px-6 py-3 font-bold text-[#6038ef]" onClick={() => props.onNavigate?.("home")}>返回学习首页</button>
        </div>
      </main>
    </div>;
  }
  return jsxRuntime.jsx(LearningProgressInner, { ...props, memory, onMemorySaved: setMemory });
}

function LearningProgressInner({ onNavigate: n, memory, onMemorySaved }) {
  const [r, u] = React.useState("co"),
    [i, d] = React.useState(null),
    [p, m] = React.useState(1),
    [b, h] = React.useState(null),
    [x, y] = React.useState(null),
    [j, z] = React.useState(null),
    R = $t.find((M) => M.id === r) ?? $t[0],
    N = React.useMemo(() => {
      const M = o3[R.id],
        B = c3[R.id];
      return n3.map(([Q, H], $) => ({
        id: `${R.id}-${$}`,
        label: M[$],
        accuracy: B[$],
        x: Q,
        y: H,
        lessonIndex: $ % R.chapters.length,
      }));
    }, [R]),
    E = Math.round(N.reduce((M, B) => M + (B.accuracy ?? 0), 0) / N.length),
    _ = (M) => {
      if (M === "progress") {
        (y(null), h(null), z(null));
        return;
      }
      n(M);
    };
  if (b)
    return jsxRuntime.jsx(zs, {
      "code-path": "src\\pages\\LearningProgress.tsx:128:12",
      onComplete: () => {
        (y({ ...b, mode: "presentation" }), h(null));
      },
    });
  if (x) {
    const M = {
      course: x.course,
      lessonTitle: x.node.label,
      lessonIndex: x.node.lessonIndex,
      onBack: () => y(null),
      onNavigate: _,
    };
    return x.mode === "presentation"
      ? jsxRuntime.jsx(Presentation, {
          "code-path": "src\\pages\\LearningProgress.tsx:142:45",
          ...M,
        })
      : jsxRuntime.jsx(Lecture, {
          "code-path": "src\\pages\\LearningProgress.tsx:142:76",
          ...M,
        });
  }
  return j
    ? jsxRuntime.jsx(dc, {
        "code-path": "src\\pages\\LearningProgress.tsx:146:12",
        course: R,
        lessonTitle: j.label,
        lessonIndex: j.lessonIndex ?? 0,
        onExit: () => z(null),
      })
    : jsxRuntime.jsxs("div", {
        "code-path": "src\\pages\\LearningProgress.tsx:150:5",
        className: "min-h-screen bg-[#fbfbfd]",
        children: [
          jsxRuntime.jsx(AppNavigation, {
            "code-path": "src\\pages\\LearningProgress.tsx:151:7",
            active: "progress",
            onNavigate: _,
          }),
          jsxRuntime.jsxs("main", {
            "code-path": "src\\pages\\LearningProgress.tsx:152:7",
            className: "mx-auto max-w-[1240px] px-5 pb-14 pt-8 sm:px-8",
            children: [
              jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\LearningProgress.tsx:153:9",
                className: "text-center",
                children: [
                  jsxRuntime.jsx("h1", {
                    "code-path": "src\\pages\\LearningProgress.tsx:154:11",
                    className:
                      "text-4xl font-black tracking-tight text-[#111318]",
                    children: "我的画像",
                  }),
                  jsxRuntime.jsx("p", {
                    "code-path": "src\\pages\\LearningProgress.tsx:155:11",
                    className: "mt-2 font-semibold text-[#878b95]",
                    children: "目标、偏好与长期记忆",
                  }),
                ],
              }),
              jsxRuntime.jsx(LearnerMemoryCard, { memory, onSaved: onMemorySaved }),
              jsxRuntime.jsx("div", {
                "code-path": "src\\pages\\LearningProgress.tsx:158:9",
                className: "mt-5 flex flex-wrap justify-center gap-2.5",
                children: [...$t].reverse().map((M) =>
                  jsxRuntime.jsxs(
                    "button",
                    {
                      "code-path": "src\\pages\\LearningProgress.tsx:160:13",
                      type: "button",
                      onClick: () => {
                        (u(M.id), d(null));
                      },
                      className: `flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-extrabold transition ${R.id === M.id ? "border-[#6038ef] bg-[#f0ebff] text-[#6038ef] shadow-sm" : "border-black/[0.10] bg-white text-[#555a65] hover:border-[#6038ef]/35"}`,
                      children: [
                        jsxRuntime.jsx("img", {
                          "code-path":
                            "src\\pages\\LearningProgress.tsx:161:15",
                          src: M.icon,
                          alt: "",
                          className: "h-5 w-5 object-contain",
                        }),
                        M.name,
                      ],
                    },
                    M.id,
                  ),
                ),
              }),
              jsxRuntime.jsxs("section", {
                "code-path": "src\\pages\\LearningProgress.tsx:166:9",
                className:
                  "mt-6 overflow-hidden rounded-2xl border border-black/[0.11] bg-white p-5 shadow-[0_5px_24px_rgba(17,19,24,0.035)] sm:p-7",
                children: [
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\LearningProgress.tsx:167:11",
                    className: "flex items-start justify-between gap-5",
                    children: [
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\LearningProgress.tsx:168:13",
                        children: [
                          jsxRuntime.jsxs("h2", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:169:15",
                            className: "text-xl font-black text-[#111318]",
                            children: [R.name, " · 知识图谱"],
                          }),
                          jsxRuntime.jsxs("p", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:170:15",
                            className:
                              "mt-2 text-sm font-semibold text-[#747883]",
                            children: [
                              "总体掌握度 ",
                              jsxRuntime.jsxs("strong", {
                                "code-path":
                                  "src\\pages\\LearningProgress.tsx:170:78",
                                className: "ml-1 text-xl text-[#6038ef]",
                                children: [E, "%"],
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\LearningProgress.tsx:172:13",
                        className: "flex gap-2",
                        children: [
                          jsxRuntime.jsx("button", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:173:15",
                            type: "button",
                            onClick: () => m((M) => Math.max(0.85, M - 0.1)),
                            className:
                              "flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.10] hover:bg-[#f4f1fc]",
                            "aria-label": "缩小图谱",
                            children: jsxRuntime.jsx(W2, {
                              "code-path":
                                "src\\pages\\LearningProgress.tsx:173:229",
                              className: "h-4 w-4",
                            }),
                          }),
                          jsxRuntime.jsx("button", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:174:15",
                            type: "button",
                            onClick: () => m((M) => Math.min(1.25, M + 0.1)),
                            className:
                              "flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.10] hover:bg-[#f4f1fc]",
                            "aria-label": "放大图谱",
                            children: jsxRuntime.jsx(rc, {
                              "code-path":
                                "src\\pages\\LearningProgress.tsx:174:230",
                              className: "h-4 w-4",
                            }),
                          }),
                        ],
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("div", {
                    "code-path": "src\\pages\\LearningProgress.tsx:178:11",
                    className: "mt-2 overflow-x-auto",
                    children: jsxRuntime.jsxs("svg", {
                      "code-path": "src\\pages\\LearningProgress.tsx:179:13",
                      viewBox: "0 0 1040 455",
                      className: "h-auto min-w-[880px] w-full",
                      role: "img",
                      "aria-label": `${R.name}知识图谱`,
                      children: [
                        jsxRuntime.jsx("defs", {
                          "code-path":
                            "src\\pages\\LearningProgress.tsx:180:15",
                          children: jsxRuntime.jsx("marker", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:181:17",
                            id: "graph-arrow",
                            markerWidth: "8",
                            markerHeight: "8",
                            refX: "7",
                            refY: "4",
                            orient: "auto",
                            children: jsxRuntime.jsx("path", {
                              "code-path":
                                "src\\pages\\LearningProgress.tsx:181:107",
                              d: "M0,0 L8,4 L0,8 Z",
                              fill: "#aeb6cc",
                            }),
                          }),
                        }),
                        jsxRuntime.jsxs("g", {
                          "code-path":
                            "src\\pages\\LearningProgress.tsx:183:15",
                          transform: `translate(${520 * (1 - p)} ${225 * (1 - p)}) scale(${p})`,
                          className: "transition-transform duration-300",
                          children: [
                            s3.map((M, B) => {
                              const Q = N[M.from],
                                H = N[M.to];
                              return jsxRuntime.jsx(
                                "line",
                                {
                                  "code-path":
                                    "src\\pages\\LearningProgress.tsx:187:26",
                                  x1: Q.x,
                                  y1: Q.y,
                                  x2: H.x,
                                  y2: H.y,
                                  className: "knowledge-edge",
                                  stroke: "#aeb6cc",
                                  strokeWidth: "1.6",
                                  markerEnd: "url(#graph-arrow)",
                                },
                                B,
                              );
                            }),
                            N.map((M) => {
                              const B = r3(M.accuracy);
                              return jsxRuntime.jsx(
                                "g",
                                {
                                  "code-path":
                                    "src\\pages\\LearningProgress.tsx:192:21",
                                  transform: `translate(${M.x} ${M.y})`,
                                  children: jsxRuntime.jsxs("g", {
                                    "code-path":
                                      "src\\pages\\LearningProgress.tsx:193:23",
                                    className:
                                      "knowledge-node cursor-pointer outline-none",
                                    role: "button",
                                    tabIndex: 0,
                                    onClick: () => d(M),
                                    onKeyDown: (Q) =>
                                      (Q.key === "Enter" || Q.key === " ") &&
                                      d(M),
                                    "aria-label": `${M.label}，${M.accuracy === null ? "未学习" : `正确率${M.accuracy}%`}`,
                                    children: [
                                      M.accuracy !== null &&
                                        M.accuracy >= 40 &&
                                        M.accuracy < 70 &&
                                        jsxRuntime.jsx("circle", {
                                          "code-path":
                                            "src\\pages\\LearningProgress.tsx:194:97",
                                          r: "38",
                                          fill: B.light,
                                          opacity: ".6",
                                          className: "knowledge-pulse",
                                        }),
                                      jsxRuntime.jsx("circle", {
                                        "code-path":
                                          "src\\pages\\LearningProgress.tsx:195:25",
                                        r: "29",
                                        fill: B.light,
                                        stroke: B.stroke,
                                        strokeWidth: "2",
                                      }),
                                      jsxRuntime.jsx("circle", {
                                        "code-path":
                                          "src\\pages\\LearningProgress.tsx:196:25",
                                        r: "24",
                                        fill: B.fill,
                                      }),
                                      jsxRuntime.jsx("text", {
                                        "code-path":
                                          "src\\pages\\LearningProgress.tsx:197:25",
                                        y: "6",
                                        textAnchor: "middle",
                                        fill: "white",
                                        fontSize: "15",
                                        fontWeight: "900",
                                        children:
                                          M.accuracy === null
                                            ? "?"
                                            : `${M.accuracy}%`,
                                      }),
                                      jsxRuntime.jsx("text", {
                                        "code-path":
                                          "src\\pages\\LearningProgress.tsx:198:25",
                                        y: "48",
                                        textAnchor: "middle",
                                        fill: "#282b32",
                                        fontSize: "13",
                                        fontWeight: "700",
                                        children: M.label,
                                      }),
                                    ],
                                  }),
                                },
                                M.id,
                              );
                            }),
                          ],
                        }),
                      ],
                    }),
                  }),
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\LearningProgress.tsx:207:11",
                    className:
                      "flex flex-wrap items-center justify-center gap-x-8 gap-y-3 border-t border-black/[0.07] pt-5 text-sm font-semibold text-[#747883]",
                    children: [
                      jsxRuntime.jsxs("span", {
                        "code-path": "src\\pages\\LearningProgress.tsx:208:13",
                        className: "flex items-center gap-2",
                        children: [
                          jsxRuntime.jsx("i", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:208:55",
                            className: "h-3 w-3 rounded-full bg-[#6541dd]",
                          }),
                          "掌握较好",
                        ],
                      }),
                      jsxRuntime.jsxs("span", {
                        "code-path": "src\\pages\\LearningProgress.tsx:209:13",
                        className: "flex items-center gap-2",
                        children: [
                          jsxRuntime.jsx("i", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:209:55",
                            className: "h-3 w-3 rounded-full bg-[#10b9ad]",
                          }),
                          "学习中",
                        ],
                      }),
                      jsxRuntime.jsxs("span", {
                        "code-path": "src\\pages\\LearningProgress.tsx:210:13",
                        className: "flex items-center gap-2",
                        children: [
                          jsxRuntime.jsx("i", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:210:55",
                            className: "h-3 w-3 rounded-full bg-[#ff765f]",
                          }),
                          "薄弱点",
                        ],
                      }),
                      jsxRuntime.jsxs("span", {
                        "code-path": "src\\pages\\LearningProgress.tsx:211:13",
                        className: "flex items-center gap-2",
                        children: [
                          jsxRuntime.jsx("i", {
                            "code-path":
                              "src\\pages\\LearningProgress.tsx:211:55",
                            className: "h-3 w-3 rounded-full bg-[#aeb3bd]",
                          }),
                          "未学习",
                        ],
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("p", {
                    "code-path": "src\\pages\\LearningProgress.tsx:213:11",
                    className:
                      "mt-4 text-center text-sm font-semibold text-[#9a9da6]",
                    children: "鼠标经过节点查看动效 · 点击节点查看知识点详情",
                  }),
                ],
              }),
            ],
          }),
          i &&
            jsxRuntime.jsx(i3, {
              "code-path": "src\\pages\\LearningProgress.tsx:218:9",
              course: R,
              node: i,
              onClose: () => d(null),
              onReview: (M) => {
                (M === "presentation"
                  ? h({ course: R, node: i })
                  : y({ course: R, node: i, mode: M }),
                  d(null));
              },
              onRetest: () => {
                (z(i), d(null));
              },
            }),
        ],
      });
}

const u3 = [
  "帮我制定今天的学习计划",
  "解释一个我不懂的知识点",
  "根据我的进度推荐课程",
];

function AIChat({ onNavigate: n }) {
  return jsxRuntime.jsxs("div", {
    className: "flex h-screen flex-col overflow-hidden bg-[#f7f7fa]",
    children: [
      jsxRuntime.jsx(AppNavigation, { active: "coach", onNavigate: n }),
      jsxRuntime.jsx("main", {
        className: "mx-auto flex min-h-0 w-full max-w-[1180px] flex-1 flex-col px-4 py-5 sm:px-7 sm:py-7",
        children: jsxRuntime.jsx(TutorChat, { fullPage: true, suggestions: u3 }),
      }),
    ],
  });
}

const p3 = [
  "北京市",
  "上海市",
  "广东省",
  "浙江省",
  "江苏省",
  "四川省",
  "湖北省",
  "山东省",
  "陕西省",
  "其他地区",
];

// Keeps uploaded avatars small enough for the profile API (64KB body limit):
// center-crop to a square, downscale, and re-encode before it reaches the server.
function zxAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("头像读取失败"));
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      if (!raw) {
        reject(new Error("头像读取失败"));
        return;
      }
      if (raw.length <= 36000) {
        resolve(raw);
        return;
      }
      const image = new Image();
      image.onerror = () => resolve(raw);
      image.onload = () => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const side = Math.min(width, height);
        if (!side) {
          resolve(raw);
          return;
        }
        const attempts = [
          { type: "image/webp", size: 512, quality: 0.82 },
          { type: "image/webp", size: 384, quality: 0.78 },
          { type: "image/jpeg", size: 384, quality: 0.82 },
          { type: "image/jpeg", size: 256, quality: 0.8 },
          { type: "image/jpeg", size: 192, quality: 0.72 },
        ];
        let best = "";
        for (const attempt of attempts) {
          const canvas = document.createElement("canvas");
          canvas.width = attempt.size;
          canvas.height = attempt.size;
          const context = canvas.getContext("2d");
          if (!context) break;
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          if (attempt.type === "image/jpeg") {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, attempt.size, attempt.size);
          }
          context.drawImage(
            image,
            (width - side) / 2,
            (height - side) / 2,
            side,
            side,
            0,
            0,
            attempt.size,
            attempt.size,
          );
          let candidate = "";
          try {
            candidate = canvas.toDataURL(attempt.type, attempt.quality);
          } catch {
            candidate = "";
          }
          if (!candidate || !candidate.startsWith("data:" + attempt.type)) continue;
          if (!best || candidate.length < best.length) best = candidate;
          if (candidate.length <= 36000) break;
        }
        resolve(best || raw);
      };
      image.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

function ProfileEditor({ profile: n, onBack: r, onSave: u, onNavigate: i }) {
  const [d, p] = React.useState(n),
    [m, b] = React.useState(""),
    [S, T] = React.useState(""),
    [h, x] = React.useState(!1),
    y = React.useRef(null),
    j = (N, E) => {
      (p((_) => ({ ..._, [N]: E })), x(!1), T(""));
    },
    z = (N) => {
      const E = N.target.files?.[0];
      N.target.value = "";
      if (!E) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(E.type)) {
        b("请上传 JPG、PNG 或 WebP 格式的图片");
        return;
      }
      if (E.size > 5 * 1024 * 1024) {
        b("头像大小不能超过 5MB");
        return;
      }
      b("");
      zxAvatarDataUrl(E)
        .then((_) => j("avatar", _))
        .catch(() => b("图片读取失败，请换一张重试"));
    },
    R = (N) => {
      N.preventDefault();
      const E = {
        ...d,
        name: (d.name || "").trim(),
        phone: (d.phone || "").trim(),
        email: (d.email || "").trim(),
      };
      p(E);
      b("");
      T("");
      x(!0);
      Promise.resolve()
        .then(() => u(E))
        .then(() => {
          x(!1);
        })
        .catch((error) => {
          x(!1);
          T((error && error.message) || "保存失败，请稍后重试");
        });
    };
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\pages\\ProfileEditor.tsx:78:5",
    className: "min-h-screen bg-[#f5f6f8]",
    children: [
      jsxRuntime.jsx(AppNavigation, {
        "code-path": "src\\pages\\ProfileEditor.tsx:79:7",
        active: "home",
        onNavigate: i,
      }),
      jsxRuntime.jsxs("main", {
        "code-path": "src\\pages\\ProfileEditor.tsx:81:7",
        className: "mx-auto max-w-[1280px] px-5 pb-14 pt-8 sm:px-8",
        children: [
          jsxRuntime.jsxs("button", {
            "code-path": "src\\pages\\ProfileEditor.tsx:82:9",
            type: "button",
            onClick: r,
            className:
              "flex items-center gap-2 text-sm font-extrabold text-[#747883] transition hover:text-[#6038ef]",
            children: [
              jsxRuntime.jsx(lu, {
                "code-path": "src\\pages\\ProfileEditor.tsx:87:11",
                className: "h-4 w-4",
              }),
              " 返回个人档案",
            ],
          }),
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\ProfileEditor.tsx:90:9",
            className: "mt-5",
            children: [
              jsxRuntime.jsx("h1", {
                "code-path": "src\\pages\\ProfileEditor.tsx:91:11",
                className:
                  "text-3xl font-black tracking-tight text-[#111318] sm:text-4xl",
                children: "编辑个人资料",
              }),
              jsxRuntime.jsx("p", {
                "code-path": "src\\pages\\ProfileEditor.tsx:92:11",
                className: "mt-2 font-semibold text-[#858995]",
                children:
                  "完善个人信息，让 Lumin 老师为你提供更贴合目标的学习建议。",
              }),
            ],
          }),
          jsxRuntime.jsxs("div", {
            "code-path": "src\\pages\\ProfileEditor.tsx:95:9",
            className:
              "mt-7 grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]",
            children: [
              jsxRuntime.jsxs("aside", {
                "code-path": "src\\pages\\ProfileEditor.tsx:96:11",
                className:
                  "overflow-hidden rounded-[28px] border border-black/[0.06] bg-white shadow-[0_14px_45px_rgba(22,19,34,0.06)]",
                children: [
                  jsxRuntime.jsx("div", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:97:13",
                    className:
                      "h-24 bg-gradient-to-r from-[#6239ef] via-[#7b42f3] to-[#8c5ff1]",
                  }),
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:98:13",
                    className: "px-7 pb-8 text-center",
                    children: [
                      jsxRuntime.jsx("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:99:15",
                        className:
                          "mx-auto -mt-14 flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-[6px] border-white bg-[#55aa32] text-4xl font-black text-white shadow-lg",
                        style: d.avatarBackground ? { backgroundColor: d.avatarBackground } : undefined,
                        children: d.avatar
                          ? jsxRuntime.jsx("img", {
                              "code-path":
                                "src\\pages\\ProfileEditor.tsx:101:19",
                              src: d.avatar,
                              alt: d.name,
                              className: "h-full w-full object-cover",
                            })
                          : (d.name || "").trim().slice(0, 1) || "李",
                      }),
                      jsxRuntime.jsx("h2", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:106:15",
                        className: "mt-4 text-2xl font-black text-[#111318]",
                        children: d.name || "你的姓名",
                      }),
                      jsxRuntime.jsx("p", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:107:15",
                        className: "mt-1 text-sm font-bold text-[#858995]",
                        children: "学员",
                      }),
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:109:15",
                        className:
                          "mt-6 rounded-2xl bg-[#f6f3ff] px-4 py-4 text-left",
                        children: [
                          jsxRuntime.jsxs("p", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:110:17",
                            className:
                              "flex items-center gap-2 text-sm font-extrabold text-[#6038ef]",
                            children: [
                              jsxRuntime.jsx(dy, {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:111:19",
                                className: "h-5 w-5",
                              }),
                              " 信息安全说明",
                            ],
                          }),
                          jsxRuntime.jsx("p", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:113:17",
                            className:
                              "mt-2 text-xs font-semibold leading-5 text-[#777b86]",
                            children:
                              "你的个人信息仅用于完善学习体验，不会显示在课程或公开页面中。",
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsxs("form", {
                "code-path": "src\\pages\\ProfileEditor.tsx:120:11",
                onSubmit: R,
                className:
                  "rounded-[28px] border border-black/[0.06] bg-white p-6 shadow-[0_14px_45px_rgba(22,19,34,0.06)] sm:p-8 lg:p-10",
                children: [
                  jsxRuntime.jsxs("section", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:121:13",
                    children: [
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:122:15",
                        className: "flex items-center gap-3",
                        children: [
                          jsxRuntime.jsx("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:123:17",
                            className:
                              "flex h-10 w-10 items-center justify-center rounded-xl bg-[#eee9ff] text-[#6038ef]",
                            children: jsxRuntime.jsx(vs, {
                              "code-path":
                                "src\\pages\\ProfileEditor.tsx:124:19",
                              className: "h-5 w-5",
                            }),
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:126:17",
                            children: [
                              jsxRuntime.jsx("h2", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:127:19",
                                className: "text-lg font-black text-[#111318]",
                                children: "头像",
                              }),
                              jsxRuntime.jsx("p", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:128:19",
                                className:
                                  "text-xs font-semibold text-[#9296a1]",
                                children: "支持 JPG、PNG、WebP，大小不超过 5MB，将自动压缩为正方形",
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:132:15",
                        className:
                          "mt-5 flex flex-wrap items-center gap-5 rounded-2xl border border-dashed border-[#6038ef]/25 bg-[#faf9fe] p-5",
                        children: [
                          jsxRuntime.jsx("button", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:133:17",
                            type: "button",
                            onClick: () => y.current?.click(),
                            className:
                              "group flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-[#c9c1e8] bg-white text-[#9b9eaa] transition hover:border-[#6038ef] hover:text-[#6038ef]",
                            "aria-label": "上传头像",
                            children: d.avatar
                              ? jsxRuntime.jsx("img", {
                                  "code-path":
                                    "src\\pages\\ProfileEditor.tsx:139:34",
                                  src: d.avatar,
                                  alt: "头像预览",
                                  className: "h-full w-full object-cover",
                                })
                              : jsxRuntime.jsx(vs, {
                                  "code-path":
                                    "src\\pages\\ProfileEditor.tsx:139:112",
                                  className:
                                    "h-6 w-6 transition group-hover:scale-110",
                                }),
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:141:17",
                            children: [
                              jsxRuntime.jsx("button", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:142:19",
                                type: "button",
                                onClick: () => y.current?.click(),
                                className:
                                  "text-sm font-black text-[#6038ef] hover:underline",
                                children: "点击上传头像",
                              }),
                              jsxRuntime.jsx("p", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:145:19",
                                className:
                                  "mt-1 text-xs font-semibold text-[#9296a1]",
                                children: "建议使用清晰的正方形照片",
                              }),
                              m &&
                                jsxRuntime.jsx("p", {
                                  "code-path":
                                    "src\\pages\\ProfileEditor.tsx:146:35",
                                  className:
                                    "mt-1 text-xs font-bold text-[#e54747]",
                                  children: m,
                                }),
                            ],
                          }),
                          jsxRuntime.jsx("input", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:148:17",
                            ref: y,
                            type: "file",
                            accept: "image/jpeg,image/png,image/webp",
                            onChange: z,
                            className: "hidden",
                          }),
                        ],
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("div", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:152:13",
                    className: "my-8 h-px bg-black/[0.06]",
                  }),
                  jsxRuntime.jsxs("section", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:154:13",
                    children: [
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:155:15",
                        className: "mb-6 flex items-center gap-3",
                        children: [
                          jsxRuntime.jsx("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:156:17",
                            className:
                              "flex h-10 w-10 items-center justify-center rounded-xl bg-[#eee9ff] text-[#6038ef]",
                            children: jsxRuntime.jsx(yy, {
                              "code-path":
                                "src\\pages\\ProfileEditor.tsx:157:19",
                              className: "h-5 w-5",
                            }),
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:159:17",
                            children: [
                              jsxRuntime.jsx("h2", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:160:19",
                                className: "text-lg font-black text-[#111318]",
                                children: "基本信息",
                              }),
                              jsxRuntime.jsx("p", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:161:19",
                                className:
                                  "text-xs font-semibold text-[#9296a1]",
                                children: "带星号的信息为必填项",
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:165:15",
                        className: "grid gap-5 sm:grid-cols-2",
                        children: [
                          jsxRuntime.jsxs("label", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:166:17",
                            className: "sm:col-span-2",
                            children: [
                              jsxRuntime.jsxs("span", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:167:19",
                                className:
                                  "text-sm font-extrabold text-[#454852]",
                                children: [
                                  "姓名 ",
                                  jsxRuntime.jsx("b", {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:167:78",
                                    className: "text-[#e54747]",
                                    children: "*",
                                  }),
                                ],
                              }),
                              jsxRuntime.jsx("input", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:168:19",
                                required: !0,
                                value: d.name,
                                onChange: (N) => j("name", N.target.value),
                                placeholder: "请输入姓名",
                                className:
                                  "mt-2 h-13 w-full rounded-2xl border border-black/[0.10] bg-white px-4 py-3.5 text-sm font-bold text-[#262930] outline-none transition placeholder:text-[#b2b5be] focus:border-[#6038ef]/45 focus:ring-4 focus:ring-[#6038ef]/[0.07]",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("fieldset", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:171:17",
                            children: [
                              jsxRuntime.jsxs("legend", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:172:19",
                                className:
                                  "text-sm font-extrabold text-[#454852]",
                                children: ["性别"],
                              }),
                              jsxRuntime.jsx("div", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:173:19",
                                className:
                                  "mt-3 flex h-[46px] items-center gap-5",
                                children: ["男", "女", "其他"].map((N) =>
                                  jsxRuntime.jsxs(
                                    "label",
                                    {
                                      "code-path":
                                        "src\\pages\\ProfileEditor.tsx:175:23",
                                      className:
                                        "flex cursor-pointer items-center gap-2 text-sm font-bold text-[#555964]",
                                      children: [
                                        jsxRuntime.jsx("input", {
                                          "code-path":
                                            "src\\pages\\ProfileEditor.tsx:176:25",
                                          type: "radio",
                                          name: "gender",
                                          value: N,
                                          checked: d.gender === N,
                                          onChange: () => j("gender", N),
                                          className: "h-4 w-4 accent-[#6038ef]",
                                        }),
                                        N,
                                      ],
                                    },
                                    N,
                                  ),
                                ),
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("label", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:183:17",
                            children: [
                              jsxRuntime.jsxs("span", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:184:19",
                                className:
                                  "flex items-center gap-1.5 text-sm font-extrabold text-[#454852]",
                                children: [
                                  jsxRuntime.jsx(_m, {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:184:101",
                                    className: "h-4 w-4 text-[#858995]",
                                  }),
                                  "出生日期",
                                ],
                              }),
                              jsxRuntime.jsx("input", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:185:19",
                                type: "date",
                                value: d.birthday,
                                onChange: (N) => j("birthday", N.target.value),
                                className:
                                  "mt-2 w-full rounded-2xl border border-black/[0.10] bg-white px-4 py-3.5 text-sm font-bold text-[#555964] outline-none transition focus:border-[#6038ef]/45 focus:ring-4 focus:ring-[#6038ef]/[0.07]",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("label", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:188:17",
                            className: "sm:col-span-2",
                            children: [
                              jsxRuntime.jsxs("span", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:189:19",
                                className:
                                  "flex items-center gap-1.5 text-sm font-extrabold text-[#454852]",
                                children: [
                                  jsxRuntime.jsx(Q2, {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:189:101",
                                    className: "h-4 w-4 text-[#858995]",
                                  }),
                                  "所在地区",
                                ],
                              }),
                              jsxRuntime.jsxs("select", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:190:19",
                                value: d.region,
                                onChange: (N) => j("region", N.target.value),
                                className:
                                  "mt-2 w-full rounded-2xl border border-black/[0.10] bg-white px-4 py-3.5 text-sm font-bold text-[#555964] outline-none transition focus:border-[#6038ef]/45 focus:ring-4 focus:ring-[#6038ef]/[0.07]",
                                children: [
                                  jsxRuntime.jsx("option", {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:191:21",
                                    value: "",
                                    disabled: !0,
                                    children: "请选择所在地区",
                                  }),
                                  p3.map((N) =>
                                    jsxRuntime.jsx(
                                      "option",
                                      {
                                        "code-path":
                                          "src\\pages\\ProfileEditor.tsx:192:46",
                                        value: N,
                                        children: N,
                                      },
                                      N,
                                    ),
                                  ),
                                ],
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("label", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:196:17",
                            className: "sm:col-span-2",
                            children: [
                              jsxRuntime.jsxs("span", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:197:19",
                                className:
                                  "flex items-center gap-1.5 text-sm font-extrabold text-[#454852]",
                                children: [
                                  jsxRuntime.jsx(ty, {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:197:101",
                                    className: "h-4 w-4 text-[#858995]",
                                  }),
                                  "手机号",
                                ],
                              }),
                              jsxRuntime.jsxs("div", {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:198:19",
                                className: "mt-2 flex gap-2.5",
                                children: [
                                  jsxRuntime.jsxs("select", {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:199:21",
                                    value: d.dialCode,
                                    onChange: (N) =>
                                      j("dialCode", N.target.value),
                                    className:
                                      "w-28 rounded-2xl border border-black/[0.10] bg-white px-3 text-sm font-bold text-[#454852] outline-none focus:border-[#6038ef]/45",
                                    children: [
                                      jsxRuntime.jsx("option", {
                                        "code-path":
                                          "src\\pages\\ProfileEditor.tsx:200:23",
                                        value: "+86",
                                        children: "+86",
                                      }),
                                      jsxRuntime.jsx("option", {
                                        "code-path":
                                          "src\\pages\\ProfileEditor.tsx:201:23",
                                        value: "+852",
                                        children: "+852",
                                      }),
                                      jsxRuntime.jsx("option", {
                                        "code-path":
                                          "src\\pages\\ProfileEditor.tsx:202:23",
                                        value: "+853",
                                        children: "+853",
                                      }),
                                      jsxRuntime.jsx("option", {
                                        "code-path":
                                          "src\\pages\\ProfileEditor.tsx:203:23",
                                        value: "+886",
                                        children: "+886",
                                      }),
                                    ],
                                  }),
                                  jsxRuntime.jsx("input", {
                                    "code-path":
                                      "src\\pages\\ProfileEditor.tsx:205:21",
                                    inputMode: "tel",
                                    pattern: "[0-9]{6,15}",
                                    value: d.phone,
                                    onChange: (N) =>
                                      j(
                                        "phone",
                                        N.target.value.replace(/\D/g, ""),
                                      ),
                                    placeholder: "请输入手机号",
                                    className:
                                      "min-w-0 flex-1 rounded-2xl border border-black/[0.10] bg-white px-4 py-3.5 text-sm font-bold text-[#262930] outline-none transition placeholder:text-[#b2b5be] focus:border-[#6038ef]/45 focus:ring-4 focus:ring-[#6038ef]/[0.07]",
                                  }),
                                ],
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\ProfileEditor.tsx:209:17",
                            className:
                              "flex items-start gap-2 rounded-2xl border border-black/[0.06] bg-[#f8f8fa] px-4 py-3.5 text-xs font-semibold leading-5 text-[#777b86] sm:col-span-2",
                            children: [
                              jsxRuntime.jsx(G2, {
                                "code-path":
                                  "src\\pages\\ProfileEditor.tsx:210:101",
                                className: "mt-0.5 h-4 w-4 shrink-0 text-[#858995]",
                              }),
                              "邮箱或工号是注册时的登录账号，无需在此重复填写；如需更换，请联系机构管理员。",
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("div", {
                    "code-path": "src\\pages\\ProfileEditor.tsx:216:13",
                    className:
                      "mt-9 flex flex-col-reverse gap-3 border-t border-black/[0.06] pt-6 sm:flex-row sm:items-center sm:justify-end",
                    children: [
                      S &&
                        jsxRuntime.jsx("p", {
                          "code-path": "src\\pages\\ProfileEditor.tsx:216:31",
                          role: "alert",
                          className:
                            "text-xs font-bold text-[#e54747] sm:mr-auto sm:max-w-[420px]",
                          children: S,
                        }),
                      jsxRuntime.jsx("button", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:217:15",
                        type: "button",
                        onClick: r,
                        className:
                          "rounded-xl border border-black/[0.10] bg-white px-7 py-3 text-sm font-extrabold text-[#5f636e] transition hover:bg-[#f5f5f7]",
                        children: "取消",
                      }),
                      jsxRuntime.jsxs("button", {
                        "code-path": "src\\pages\\ProfileEditor.tsx:220:15",
                        type: "submit",
                        className: `flex items-center justify-center gap-2 rounded-xl px-8 py-3 text-sm font-black text-white shadow-[0_8px_22px_rgba(96,56,239,0.22)] transition hover:-translate-y-0.5 ${h ? "bg-[#28ad54]" : "bg-[#6038ef] hover:bg-[#512bdc]"}`,
                        children: [
                          h &&
                            jsxRuntime.jsx(pn, {
                              "code-path":
                                "src\\pages\\ProfileEditor.tsx:221:27",
                              className: "h-4 w-4",
                            }),
                          h ? "保存中…" : "保存修改",
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

const m3 = [
    { icon: Rm, label: "学习天数", value: "128", unit: "天" },
    { icon: Tm, label: "总学习时长", value: "256", unit: "h" },
    { icon: z2, label: "完成任务", value: "48", unit: "个" },
    { icon: m2, label: "连续学习", value: "12", unit: "天" },
  ],
  x3 = [
    {
      icon: Ny,
      color: "bg-[#6c0ef2]/10 text-[#6c0ef2]",
      title: "操作系统：进程与线程",
      time: "2024-05-20 20:30",
      duration: "45 分钟",
    },
    {
      icon: $a,
      color: "bg-[#4f8ef7]/10 text-[#4f8ef7]",
      title: "STL 容器源码解析",
      time: "2024-05-19 21:15",
      duration: "60 分钟",
    },
  ];

function g3({ done: n, total: r }) {
  const i = 2 * Math.PI * 26,
    d = r === 0 ? 0 : n / r;
  return jsxRuntime.jsxs("div", {
    "code-path": "src\\pages\\Dashboard.tsx:51:5",
    className: "relative h-16 w-16",
    children: [
      jsxRuntime.jsxs("svg", {
        "code-path": "src\\pages\\Dashboard.tsx:52:7",
        viewBox: "0 0 64 64",
        className: "h-16 w-16 -rotate-90",
        children: [
          jsxRuntime.jsx("circle", {
            "code-path": "src\\pages\\Dashboard.tsx:53:9",
            cx: "32",
            cy: "32",
            r: 26,
            fill: "none",
            stroke: "#eef0f4",
            strokeWidth: "6",
          }),
          jsxRuntime.jsx("circle", {
            "code-path": "src\\pages\\Dashboard.tsx:54:9",
            cx: "32",
            cy: "32",
            r: 26,
            fill: "none",
            stroke: "#6c0ef2",
            strokeWidth: "6",
            strokeLinecap: "round",
            strokeDasharray: i,
            strokeDashoffset: i * (1 - d),
            className: "transition-all duration-700",
          }),
        ],
      }),
      jsxRuntime.jsxs("span", {
        "code-path": "src\\pages\\Dashboard.tsx:67:7",
        className:
          "absolute inset-0 flex items-center justify-center text-sm font-extrabold text-[#111318]",
        children: [n, "/", r],
      }),
    ],
  });
}

function Dashboard({ profile: n }) {
  const location = useLocation();
  const navigate = useNavigate();
  const learning = useLearning();
  const insights = useDashboardInsights(learning.data);
  const stats = learning.data?.stats ?? {},
    dashboardMetrics = [
      { icon: Rm, label: "学习天数", value: insights.data ? String(insights.data.activity.learningDays) : "—", unit: "天" },
      { icon: z2, label: "已完成课时", value: String(stats.completedTasks ?? 0), unit: "个" },
      { icon: Tm, label: "课程总数", value: String($t.length), unit: "门" },
      { icon: m2, label: "测验累计分", value: String(stats.totalScore ?? 0), unit: "分" },
    ],
    actualRecent = Array.isArray(learning.data?.recent) ? learning.data.recent : [],
    dashboardRecent = actualRecent.length
      ? actualRecent.map((item, index) => ({
          icon: index % 2 === 0 ? Ny : $a,
          color: index % 2 === 0 ? "bg-[#6c0ef2]/10 text-[#6c0ef2]" : "bg-[#4f8ef7]/10 text-[#4f8ef7]",
          title: item.title,
          time: item.time,
          duration: "已保存进度",
        }))
      : [{
          icon: $a,
          color: "bg-[#4f8ef7]/10 text-[#4f8ef7]",
          title: "还没有学习记录",
          time: "完成一节课后会显示在这里",
          duration: "",
        }];
  const r = React.useMemo(() => {
      const O = zy(n.subjectValues);
      return O.length > 0 ? O : $t;
    }, [n.subjectValues, learning.data?.courses]),
    [i, d] = React.useState(0),
    p = location.state?.learnerView || "home",
    m = (view) => {
      if (view !== p) navigate(location.pathname + location.search, { state: { ...location.state, learnerView: view } });
    },
    [b, h] = React.useState(!1),
    [x, y] = React.useState({
      avatar: n.avatar || "",
      avatarBackground: n.avatarBackground || "",
      name: n.name || "",
      gender: n.gender || "",
      birthday: n.birthday || "",
      region: n.region || "",
      dialCode: n.dialCode || "+86",
      phone: n.phone || "",
      email: n.email || "",
    }),
    [j, z] = React.useState(!1),
    [courseTarget, setCourseTarget] = React.useState(""),
    [R, N] = React.useState(null),
    [E, _] = React.useState(null),
    M = r[Math.min(i, r.length - 1)],
    B = bs(M),
    Q = Math.max(
      M?.chapters.findIndex((O) => !O.done) ?? 0,
      0,
    ),
    H = (O) => {
      const P = bs(O);
      return Math.max(Math.round((P.total - P.done) * 1.2), 1);
    },
    $ = (O) => {
      if (O && typeof O === "object") {
        const course = $t.find((item) => item.id === O.courseId);
        if (!course) return;
        if (O.view === "course") {
          (setCourseTarget(course.id), _(null), N(null), z(!1), h(!1), m("courses"));
          return;
        }
        const lessonIndex = Number.isInteger(O.lessonIndex) ? O.lessonIndex : 0;
        if (O.view === "lecture") {
          (_({ course, lessonIndex, mode: "lecture", focusSectionId: O.sectionId || "" }), m("courses"));
          return;
        }
        if (O.view === "quiz") {
          (_({
            course,
            lessonIndex,
            mode: "quiz",
            initialQuestionIndex: Number.isInteger(O.questionIndex) ? O.questionIndex : 0,
            focusQuestionId: O.questionId || "",
          }), m("courses"));
          return;
        }
        return;
      }
      if (O === "profile") {
        (_(null), N(null), z(!1), h(!0));
        return;
      }
      if (O === "courses") setCourseTarget("");
      (O === "home" ||
        O === "courses" ||
        O === "bookmarks" ||
        O === "progress" ||
        O === "coach") &&
        (_(null), N(null), z(!1), h(!1), m(O));
    };
  if (!$t.length) return <div className="min-h-screen bg-[#fbfbfd]"><AppNavigation active={p} onNavigate={$} /><main className="mx-auto max-w-xl px-6 py-24 text-center"><h1 className="text-2xl font-black text-[#111318]">课程准备中</h1><p className="mt-4 text-sm leading-7 text-[#747883]">目前还没有上架课程，发布后即可开始学习。</p></main></div>;
  if (R)
    return jsxRuntime.jsx(zs, {
      "code-path": "src\\pages\\Dashboard.tsx:132:7",
      onComplete: () => {
        (_({ ...R, mode: "presentation" }), N(null));
      },
    });
  if (E) {
    const O = E.course.chapters[E.lessonIndex]?.title ?? E.course.name,
      P = {
        course: E.course,
        lessonTitle: O,
        lessonIndex: E.lessonIndex,
        focusSectionId: E.focusSectionId,
        onBack: () => _(null),
        onNavigate: $,
      };
    if (E.mode === "quiz") return jsxRuntime.jsx(dc, {
      ...P,
      initialQuestionIndex: E.initialQuestionIndex,
      focusQuestionId: E.focusQuestionId,
      onExit: () => _(null),
    });
    return E.mode === "lecture"
      ? jsxRuntime.jsx(Lecture, {
          "code-path": "src\\pages\\Dashboard.tsx:152:7",
          ...P,
        })
      : jsxRuntime.jsx(Presentation, {
          "code-path": "src\\pages\\Dashboard.tsx:154:7",
          ...P,
        });
  }
  return b
    ? jsxRuntime.jsx(ProfileEditor, {
        "code-path": "src\\pages\\Dashboard.tsx:160:7",
        profile: x,
        onBack: () => h(!1),
        onSave: (O) => {
          const next = { ...n, ...O };
          y(O);
          if (new TextEncoder().encode(JSON.stringify(next)).length > 64000) {
            return Promise.reject(new Error("头像或资料内容过大，请更换更小的头像图片"));
          }
          return saveProfile(next).then((saved) => {
            const value = saved && typeof saved === "object" ? saved : next;
            y((current) => ({ ...current, ...value }));
            h(!1);
            return value;
          });
        },
        onNavigate: (O) => {
          if (O === "home") {
            h(!1);
            return;
          }
          $(O);
        },
      })
    : p === "bookmarks"
      ? jsxRuntime.jsx(Bookmarks, {
          "code-path": "src\\pages\\Dashboard.tsx:179:12",
          onNavigate: $,
          onOpenBookmark: $,
        })
      : p === "courses"
        ? jsxRuntime.jsx(Courses, {
            "code-path": "src\\pages\\Dashboard.tsx:183:12",
            key: courseTarget || "courses",
            onNavigate: $,
            initialCourseId: courseTarget || undefined,
          })
        : p === "progress"
          ? jsxRuntime.jsx(LearningProgress, {
              "code-path": "src\\pages\\Dashboard.tsx:187:12",
              onNavigate: $,
            })
          : p === "coach"
            ? jsxRuntime.jsx(AIChat, {
                "code-path": "src\\pages\\Dashboard.tsx:191:12",
                onNavigate: $,
              })
            : jsxRuntime.jsxs("div", {
                "code-path": "src\\pages\\Dashboard.tsx:195:5",
                className: "zx-dashboard-page min-h-screen bg-[#f5f6f8]",
                children: [
                  jsxRuntime.jsx(AppNavigation, {
                    "code-path": "src\\pages\\Dashboard.tsx:196:7",
                    active: "home",
                    onNavigate: $,
                  }),
                  jsxRuntime.jsxs("main", {
                    "code-path": "src\\pages\\Dashboard.tsx:199:7",
                    className:
                      "zx-dashboard-grid mx-auto grid max-w-[1560px] grid-cols-1 gap-6 p-6 lg:grid-cols-[300px_minmax(0,1fr)_380px]",
                    children: [
                      jsxRuntime.jsxs("aside", {
                        "code-path": "src\\pages\\Dashboard.tsx:201:9",
                        className:
                          "zx-dashboard-profile rounded-3xl border border-black/5 bg-white p-6",
                        children: [
                          jsxRuntime.jsx("h3", {
                            "code-path": "src\\pages\\Dashboard.tsx:202:11",
                            className: "text-lg font-extrabold text-[#111318]",
                            children: "个人档案",
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:203:11",
                            className: "zx-dashboard-profile-identity mt-4 flex flex-col items-center",
                            children: [
                              jsxRuntime.jsx("div", {
                                "code-path": "src\\pages\\Dashboard.tsx:204:13",
                                className:
                                  "flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-[#5aa832] text-3xl font-extrabold text-white",
                                style: x.avatarBackground ? { backgroundColor: x.avatarBackground } : undefined,
                                children: x.avatar
                                  ? jsxRuntime.jsx("img", {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:206:17",
                                      src: x.avatar,
                                      alt: x.name,
                                      className: "h-full w-full object-cover",
                                    })
                                  : x.name.trim().slice(0, 1) || "李",
                              }),
                              jsxRuntime.jsx("p", {
                                "code-path": "src\\pages\\Dashboard.tsx:211:13",
                                className:
                                  "mt-2 text-2xl font-extrabold text-[#111318]",
                                children: x.name,
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:213:11",
                            className: "zx-dashboard-profile-details mt-4 space-y-2",
                            children: [
                              jsxRuntime.jsxs("p", {
                                "code-path": "src\\pages\\Dashboard.tsx:214:13",
                                className:
                                  "flex items-center gap-2.5 text-sm font-semibold text-[#5b5e6b]",
                                children: [
                                  jsxRuntime.jsx(jy, {
                                    "code-path":
                                      "src\\pages\\Dashboard.tsx:215:15",
                                    className: "h-4 w-4",
                                  }),
                                  " 角色：",
                                  n.roleLabel || n.education || "大学生",
                                ],
                              }),
                              jsxRuntime.jsxs("p", {
                                "code-path": "src\\pages\\Dashboard.tsx:217:13",
                                className:
                                  "flex items-center gap-2.5 text-sm font-semibold text-[#5b5e6b]",
                                children: [
                                  jsxRuntime.jsx(Um, {
                                    "code-path":
                                      "src\\pages\\Dashboard.tsx:218:15",
                                    className: "h-4 w-4",
                                  }),
                                  " 目标：",
                                  n.goalLabel || n.goal || "技能提升",
                                ],
                              }),
                            ],
                          }),
                          jsxRuntime.jsx("button", {
                            "code-path": "src\\pages\\Dashboard.tsx:221:11",
                            type: "button",
                            onClick: () => h(!0),
                            className:
                              "mt-4 w-full rounded-full bg-[#111318] py-2 text-sm font-extrabold text-white transition-transform hover:-translate-y-0.5",
                            children: "编辑资料",
                          }),
                          jsxRuntime.jsx("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:229:11",
                            className:
                              "zx-dashboard-profile-metrics mt-4 grid grid-cols-2 gap-y-3 border-t border-black/5 pt-4",
                            children: dashboardMetrics.map((O) =>
                              jsxRuntime.jsxs(
                                "div",
                                {
                                  "code-path":
                                    "src\\pages\\Dashboard.tsx:231:15",
                                  children: [
                                    jsxRuntime.jsxs("p", {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:232:17",
                                      className:
                                        "flex items-center gap-1.5 text-xs font-semibold text-[#8a8e9c]",
                                      children: [
                                        jsxRuntime.jsx(O.icon, {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:233:19",
                                          className: "h-4 w-4",
                                        }),
                                        " ",
                                        O.label,
                                      ],
                                    }),
                                    jsxRuntime.jsxs("p", {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:235:17",
                                      className:
                                        "mt-1 text-xl font-extrabold text-[#111318]",
                                      children: [
                                        O.value,
                                        jsxRuntime.jsx("span", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:237:19",
                                          className:
                                            "ml-0.5 text-xs font-bold text-[#8a8e9c]",
                                          children: O.unit,
                                        }),
                                      ],
                                    }),
                                  ],
                                },
                                O.label,
                              ),
                            ),
                          }),
                          jsxRuntime.jsx(LearningActivityGrid, { insights }),
                        ],
                      }),
                      jsxRuntime.jsxs("section", {
                        "code-path": "src\\pages\\Dashboard.tsx:245:9",
                        className: "zx-dashboard-center flex flex-col gap-6",
                        children: [
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:246:11",
                            className:
                              "zx-dashboard-continue rounded-3xl border border-black/5 bg-white p-6",
                            children: [
                              jsxRuntime.jsx("h3", {
                                "code-path": "src\\pages\\Dashboard.tsx:247:13",
                                className:
                                  "text-lg font-extrabold text-[#111318]",
                                children: "继续学习",
                              }),
                              jsxRuntime.jsxs("div", {
                                "code-path": "src\\pages\\Dashboard.tsx:249:13",
                                className: "relative mt-4",
                                children: [
                                  jsxRuntime.jsx("div", {
                                    "code-path":
                                      "src\\pages\\Dashboard.tsx:250:15",
                                    className: "overflow-hidden",
                                    children: jsxRuntime.jsx("div", {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:251:17",
                                      className:
                                        "flex transition-transform duration-500 ease-out",
                                      style: {
                                        transform: `translateX(-${i * 100}%)`,
                                      },
                                      children: r.map((O) => {
                                        const P = bs(O);
                                        return jsxRuntime.jsxs(
                                          "div",
                                          {
                                            "code-path":
                                              "src\\pages\\Dashboard.tsx:258:23",
                                            className:
                                              "flex w-full shrink-0 items-center gap-6 pr-2",
                                            children: [
                                              jsxRuntime.jsx("div", {
                                                "code-path":
                                                  "src\\pages\\Dashboard.tsx:259:25",
                                                className:
                                                  "zx-dashboard-course-art flex h-48 w-48 shrink-0 items-center justify-center rounded-2xl bg-[#f4f5f7]",
                                                children: jsxRuntime.jsx(
                                                  "img",
                                                  {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:260:27",
                                                    src: O.icon,
                                                    alt: O.name,
                                                    className:
                                                      "zx-dashboard-course-icon h-36 w-36 object-contain",
                                                  },
                                                ),
                                              }),
                                              jsxRuntime.jsxs("div", {
                                                "code-path":
                                                  "src\\pages\\Dashboard.tsx:262:25",
                                                className: "min-w-0 flex-1",
                                                children: [
                                                  jsxRuntime.jsx("p", {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:263:27",
                                                    className:
                                                      "text-xs font-semibold text-[#8a8e9c]",
                                                    children: "课程",
                                                  }),
                                                  jsxRuntime.jsx("h4", {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:264:27",
                                                    className:
                                                      "mt-1 text-2xl font-extrabold text-[#111318]",
                                                    children: O.name,
                                                  }),
                                                  jsxRuntime.jsxs("p", {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:265:27",
                                                    className:
                                                      "mt-2 text-sm font-semibold text-[#5b5e6b]",
                                                    children: [
                                                      "当前课程：",
                                                      P.current,
                                                    ],
                                                  }),
                                                  jsxRuntime.jsxs("div", {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:268:27",
                                                    className:
                                                      "mt-4 flex items-center gap-3",
                                                    children: [
                                                      jsxRuntime.jsx("div", {
                                                        "code-path":
                                                          "src\\pages\\Dashboard.tsx:269:29",
                                                        className:
                                                          "h-2 w-40 overflow-hidden rounded-full bg-[#eef0f4]",
                                                        children:
                                                          jsxRuntime.jsx(
                                                            "div",
                                                            {
                                                              "code-path":
                                                                "src\\pages\\Dashboard.tsx:270:31",
                                                              className:
                                                                "h-full rounded-full bg-[#6c0ef2] transition-all duration-700",
                                                              style: {
                                                                width: `${P.percent}%`,
                                                              },
                                                            },
                                                          ),
                                                      }),
                                                      jsxRuntime.jsxs("span", {
                                                        "code-path":
                                                          "src\\pages\\Dashboard.tsx:275:29",
                                                        className:
                                                          "text-sm font-extrabold text-[#111318]",
                                                        children: [
                                                          P.percent,
                                                          "%",
                                                        ],
                                                      }),
                                                      jsxRuntime.jsxs("span", {
                                                        "code-path":
                                                          "src\\pages\\Dashboard.tsx:276:29",
                                                        className:
                                                          "flex items-center gap-1 text-sm font-semibold text-[#8a8e9c]",
                                                        children: [
                                                          jsxRuntime.jsx(Tm, {
                                                            "code-path":
                                                              "src\\pages\\Dashboard.tsx:277:31",
                                                            className:
                                                              "h-4 w-4",
                                                          }),
                                                          " 剩余 ",
                                                          H(O),
                                                          " 小时",
                                                        ],
                                                      }),
                                                    ],
                                                  }),
                                                  jsxRuntime.jsx("button", {
                                                    "code-path":
                                                      "src\\pages\\Dashboard.tsx:280:27",
                                                    type: "button",
                                                    onClick: () => z(!0),
                                                    className:
                                                      "mt-5 w-full max-w-xs rounded-2xl bg-[#6c0ef2] py-3.5 text-base font-extrabold text-white shadow-[0_6px_18px_rgba(108,14,242,0.3)] transition-all hover:-translate-y-0.5 hover:bg-[#5a0bd2]",
                                                    children: "继续课程",
                                                  }),
                                                ],
                                              }),
                                            ],
                                          },
                                          O.id,
                                        );
                                      }),
                                    }),
                                  }),
                                  r.length > 1 &&
                                    jsxRuntime.jsxs(jsxRuntime.Fragment, {
                                      children: [
                                        jsxRuntime.jsx("button", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:296:19",
                                          onClick: () =>
                                            d(
                                              (O) =>
                                                (O - 1 + r.length) % r.length,
                                            ),
                                          className:
                                            "absolute -left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-black/10 bg-white shadow-sm transition-colors hover:bg-[#f4effe]",
                                          "aria-label": "上一门课程",
                                          children: jsxRuntime.jsx(Mm, {
                                            "code-path":
                                              "src\\pages\\Dashboard.tsx:301:21",
                                            className: "h-5 w-5",
                                          }),
                                        }),
                                        jsxRuntime.jsx("button", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:303:19",
                                          onClick: () =>
                                            d((O) => (O + 1) % r.length),
                                          className:
                                            "absolute -right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-black/10 bg-white shadow-sm transition-colors hover:bg-[#f4effe]",
                                          "aria-label": "下一门课程",
                                          children: jsxRuntime.jsx(Am, {
                                            "code-path":
                                              "src\\pages\\Dashboard.tsx:308:21",
                                            className: "h-5 w-5",
                                          }),
                                        }),
                                      ],
                                    }),
                                ],
                              }),
                              r.length > 1 &&
                                jsxRuntime.jsx("div", {
                                  "code-path":
                                    "src\\pages\\Dashboard.tsx:315:15",
                                  className: "mt-4 flex justify-center gap-1.5",
                                  children: r.map((O, P) =>
                                    jsxRuntime.jsx(
                                      "button",
                                      {
                                        "code-path":
                                          "src\\pages\\Dashboard.tsx:317:19",
                                        onClick: () => d(P),
                                        className: `h-2 rounded-full transition-all ${P === i ? "w-5 bg-[#6c0ef2]" : "w-2 bg-black/15"}`,
                                        "aria-label": `切换到${O.name}`,
                                      },
                                      O.id,
                                    ),
                                  ),
                                }),
                            ],
                          }),
                          jsxRuntime.jsx(PopularLearningResources, {
                            insights,
                            catalog: $t,
                            onOpen: _,
                            onViewAll: () => $("courses"),
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("aside", {
                        "code-path": "src\\pages\\Dashboard.tsx:363:9",
                        className: "zx-dashboard-side flex flex-col gap-6",
                        children: [
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:364:11",
                            className:
                              "rounded-3xl border border-black/5 bg-white p-6",
                            children: [
                              jsxRuntime.jsxs("div", {
                                "code-path": "src\\pages\\Dashboard.tsx:365:13",
                                className: "flex items-start justify-between",
                                children: [
                                  jsxRuntime.jsxs("div", {
                                    "code-path":
                                      "src\\pages\\Dashboard.tsx:366:15",
                                    children: [
                                      jsxRuntime.jsx("h3", {
                                        "code-path":
                                          "src\\pages\\Dashboard.tsx:367:17",
                                        className:
                                          "text-lg font-extrabold text-[#111318]",
                                        children: "我的画像",
                                      }),
                                      jsxRuntime.jsx("p", {
                                        "code-path":
                                          "src\\pages\\Dashboard.tsx:368:17",
                                        className:
                                          "mt-2 text-base font-extrabold text-[#111318]",
                                        children: M.name,
                                      }),
                                    ],
                                  }),
                                  jsxRuntime.jsx(g3, {
                                    "code-path":
                                      "src\\pages\\Dashboard.tsx:370:15",
                                    done: B.done,
                                    total: B.total,
                                  }),
                                ],
                              }),
                              jsxRuntime.jsx("div", {
                                "code-path": "src\\pages\\Dashboard.tsx:372:13",
                                className: "mt-4 space-y-2.5",
                                children: M.chapters.map((O) =>
                                  jsxRuntime.jsxs(
                                    "div",
                                    {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:374:17",
                                      className:
                                        "flex items-center justify-between rounded-xl border border-black/5 px-4 py-3",
                                      children: [
                                        jsxRuntime.jsx("span", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:378:19",
                                          className:
                                            "text-sm font-bold text-[#111318]",
                                          children: O.title,
                                        }),
                                        O.done
                                          ? jsxRuntime.jsx(pn, {
                                              "code-path":
                                                "src\\pages\\Dashboard.tsx:380:21",
                                              className:
                                                "h-5 w-5 fill-[#22c55e] text-white",
                                            })
                                          : jsxRuntime.jsx(S2, {
                                              "code-path":
                                                "src\\pages\\Dashboard.tsx:382:21",
                                              className:
                                                "h-5 w-5 text-[#d6d9e0]",
                                            }),
                                      ],
                                    },
                                    O.title,
                                  ),
                                ),
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            "code-path": "src\\pages\\Dashboard.tsx:389:11",
                            className:
                              "rounded-3xl border border-black/5 bg-white p-6",
                            children: [
                              jsxRuntime.jsx("h3", {
                                "code-path": "src\\pages\\Dashboard.tsx:390:13",
                                className:
                                  "text-lg font-extrabold text-[#111318]",
                                children: "最近学习记录",
                              }),
                              jsxRuntime.jsx("div", {
                                "code-path": "src\\pages\\Dashboard.tsx:391:13",
                                className: "mt-4 space-y-5",
                                children: dashboardRecent.map((O) =>
                                  jsxRuntime.jsxs(
                                    "div",
                                    {
                                      "code-path":
                                        "src\\pages\\Dashboard.tsx:393:17",
                                      className: "flex items-center gap-3",
                                      children: [
                                        jsxRuntime.jsx("div", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:394:19",
                                          className: `flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${O.color}`,
                                          children: jsxRuntime.jsx(O.icon, {
                                            "code-path":
                                              "src\\pages\\Dashboard.tsx:395:21",
                                            className: "h-5 w-5",
                                          }),
                                        }),
                                        jsxRuntime.jsxs("div", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:397:19",
                                          className: "min-w-0 flex-1",
                                          children: [
                                            jsxRuntime.jsx("p", {
                                              "code-path":
                                                "src\\pages\\Dashboard.tsx:398:21",
                                              className:
                                                "truncate text-sm font-extrabold text-[#111318]",
                                              children: O.title,
                                            }),
                                            jsxRuntime.jsxs("p", {
                                              "code-path":
                                                "src\\pages\\Dashboard.tsx:399:21",
                                              className:
                                                "text-xs font-semibold text-[#8a8e9c]",
                                              children: ["学习时间：", O.time],
                                            }),
                                          ],
                                        }),
                                        jsxRuntime.jsx("span", {
                                          "code-path":
                                            "src\\pages\\Dashboard.tsx:401:19",
                                          className:
                                            "shrink-0 text-xs font-bold text-[#8a8e9c]",
                                          children: O.duration,
                                        }),
                                      ],
                                    },
                                    O.title,
                                  ),
                                ),
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  j &&
                    jsxRuntime.jsx(LessonStartModal, {
                      "code-path": "src\\pages\\Dashboard.tsx:410:9",
                      course: M,
                      lessonTitle: M.chapters[Q]?.title ?? M.name,
                      lessonIndex: Q,
                      onClose: () => z(!1),
                      onSelectResource: (mode) => {
                        z(!1);
                        _({ course: M, lessonIndex: Q, mode });
                      },
                    }),
                ],
              });
}

function Home({ initialLogin = false }) {
  const learning = useLearning();
  const [n, r] = React.useState(initialLogin ? "login" : "hero"),
    [u, i] = React.useState(() => initialLogin ? null : learning.data?.profile || null),
    [displayName, setDisplayName] = React.useState("");
  return u
    ? jsxRuntime.jsx(Dashboard, {
        "code-path": "src\\pages\\Home.tsx:13:12",
        profile: u,
      })
    : n === "login"
      ? jsxRuntime.jsx(LoginPage, {
          onBack: () => r("hero"),
          onAuthenticated: (profile, name) => {
            setDisplayName(name || "");
            if (profile) {
              i({ ...profile, name: profile.name || name || "学习者" });
            } else {
              r("onboarding");
            }
          },
        })
      : jsxRuntime.jsxs("div", {
        "code-path": "src\\pages\\Home.tsx:17:5",
        className: "min-h-screen bg-white",
        children: [
          jsxRuntime.jsx(Navbar, {
            "code-path": "src\\pages\\Home.tsx:18:7",
            onGetStarted: () => r("login"),
          }),
          jsxRuntime.jsx(Hero, {
            "code-path": "src\\pages\\Home.tsx:19:7",
            onGetStarted: () => r("login"),
          }),
          jsxRuntime.jsx(Footer, { "code-path": "src\\pages\\Home.tsx:20:7" }),
          n === "onboarding" &&
            jsxRuntime.jsx(OnboardingWizard, {
              "code-path": "src\\pages\\Home.tsx:22:9",
              onClose: () => r("login"),
              onFinish: (d) => {
                const profile = { ...d, name: d.name || displayName || "学习者" };
                r("hero");
                saveProfile(profile).then((saved) => i(saved || profile)).catch(() => i(profile));
              },
            }),
        ],
      });
}

function Po() {
  const n = useNavigate(),
    { courseId: r, lessonIndex: u, lessonMode: i } = useParams();
  return jsxRuntime.jsx(Courses, {
    "code-path": "src\\App.tsx:10:5",
    initialCourseId: r,
    initialLectureIndex: u === void 0 || i !== void 0 ? void 0 : Number(u),
    initialPresentationIndex:
      i === "presentation" && u !== void 0 ? Number(u) : void 0,
    initialQuizIndex: i === "quiz" && u !== void 0 ? Number(u) : void 0,
    onNavigate: (d) => {
      (d === "home" && n("/"), d === "progress" && n("/progress"));
    },
  });
}

function v3() {
  const n = useNavigate();
  return jsxRuntime.jsx(LearningProgress, {
    "code-path": "src\\App.tsx:26:5",
    onNavigate: (r) => {
      (r === "home" && n("/"), r === "courses" && n("/courses"));
    },
  });
}

function RecoveredApp() {
  const learning = useLearning();
  const [catalogReady, setCatalogReady] = React.useState(false);
  const [, refreshCatalogView] = React.useState(0);
  const load = React.useCallback(() => {
    setCatalogReady(false);
    bootstrap()
      .then((data) => {
        setCourseCatalog(data.courses);
        setCatalogReady(true);
      })
      .catch(() => undefined);
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);
  React.useEffect(() => {
    if (!Array.isArray(learning.data?.courses)) return;
    setCourseCatalog(learning.data.courses);
    refreshCatalogView((value) => value + 1);
  }, [learning.data?.courses]);
  if (!learning.ready || !catalogReady) {
    return jsxRuntime.jsx(LoadPanel, {
      error: learning.error,
      onRetry: load,
    });
  }
  return jsxRuntime.jsxs(React.Fragment, {
    children: [
      jsxRuntime.jsxs(Routes, {
        "code-path": "src\\App.tsx:37:5",
        children: [
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:38:7",
        path: "/",
        element: jsxRuntime.jsx(Home, { "code-path": "src\\App.tsx:38:32" }),
      }),
      jsxRuntime.jsx(Route, {
        path: "/login",
        element: jsxRuntime.jsx(Home, { initialLogin: true }),
      }),
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:39:7",
        path: "/courses",
        element: jsxRuntime.jsx(Po, { "code-path": "src\\App.tsx:39:39" }),
      }),
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:40:7",
        path: "/courses/:courseId",
        element: jsxRuntime.jsx(Po, { "code-path": "src\\App.tsx:40:49" }),
      }),
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:41:7",
        path: "/courses/:courseId/lessons/:lessonIndex",
        element: jsxRuntime.jsx(Po, { "code-path": "src\\App.tsx:41:70" }),
      }),
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:42:7",
        path: "/courses/:courseId/lessons/:lessonIndex/:lessonMode",
        element: jsxRuntime.jsx(Po, { "code-path": "src\\App.tsx:42:82" }),
      }),
      jsxRuntime.jsx(Route, {
        "code-path": "src\\App.tsx:43:7",
        path: "/progress",
        element: jsxRuntime.jsx(v3, { "code-path": "src\\App.tsx:43:40" }),
      }),
        ],
      }),
      jsxRuntime.jsx(SyncStatus, {}),
    ],
  });
}
export default RecoveredApp;
