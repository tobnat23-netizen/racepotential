import React, { useMemo, useState } from "react";
import { motion, useScroll, useSpring, useTransform } from "framer-motion";
import { jsPDF } from "jspdf";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Flame,
  Gauge,
  Info,
  Lock,
  MapPin,
  Medal,
  Plus,
  Share2,
  Sparkles,
  TimerReset,
  TrendingDown,
  Zap,
} from "lucide-react";

const DISTANCES = [
  { id: "100", label: "100m", meters: 100, group: "sprint" },
  { id: "200", label: "200m", meters: 200, group: "sprint" },
  { id: "300", label: "300m", meters: 300, group: "sprint" },
  { id: "400", label: "400m", meters: 400, group: "sprint" },
  { id: "600", label: "600m", meters: 600, group: "middle" },
  { id: "800", label: "800m", meters: 800, group: "middle" },
  { id: "1000", label: "1000m", meters: 1000, group: "middle" },
  { id: "1500", label: "1500m", meters: 1500, group: "middle" },
  { id: "mile", label: "Mile", meters: 1609.344, group: "middle" },
  { id: "2000", label: "2000m", meters: 2000, group: "middle" },
  { id: "3000", label: "3000m", meters: 3000, group: "distance" },
  { id: "2mile", label: "2 Mile", meters: 3218.688, group: "distance" },
  { id: "5000", label: "5K", meters: 5000, group: "distance" },
  { id: "10000", label: "10K", meters: 10000, group: "distance" },
  { id: "half", label: "Half Marathon", meters: 21097.5, group: "distance" },
  { id: "marathon", label: "Marathon", meters: 42195, group: "distance" },
];

const PROFILE_CONFIG = {
  sprinter: {
    label: "Sprinter",
    description: "Best for athletes focused on 100m to 400m, with optional 600m and 800m crossover.",
    inputs: ["100", "200", "300", "400", "600", "800"],
    defaultTarget: "400",
  },
  middle: {
    label: "Middle Distance",
    description: "Built for 400m to 3000m athletes who need both speed and aerobic support.",
    inputs: ["200", "400", "600", "800", "1000", "1500", "mile", "2000", "3000"],
    defaultTarget: "800",
  },
  distance: {
    label: "Long Distance",
    description: "For athletes targeting 3000m to marathon with endurance-specific modeling.",
    inputs: ["1500", "mile", "2000", "3000", "2mile", "5000", "10000", "half", "marathon"],
    defaultTarget: "5000",
  },
};

const KSA_TABLE = {
  "100/200": { p25: 0.983886, median: 0.992446, p75: 1.002153, p90: 1.011601 },
  "200/400": { p25: 0.904724, median: 0.912, p75: 0.922657, p90: 0.927855 },
  "400/800": { p25: 0.87364, median: 0.88794, p75: 0.897323, p90: 0.904845 },
  "800/1500": { p25: 0.911015, median: 0.921097, p75: 0.929758, p90: 0.937127 },
};

function parseTimeToSeconds(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.includes(":")) {
    const parts = v.split(":").map((part) => Number(part.replace(",", ".")));
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }
  const seconds = Number(v.replace(",", "."));
  return Number.isNaN(seconds) ? null : seconds;
}

function formatSeconds(total) {
  if (total == null || !Number.isFinite(total)) return "–";
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const rem = total - h * 3600;
    const m = Math.floor(rem / 60);
    const s = (rem - m * 60).toFixed(2).padStart(5, "0");
    return `${h}:${String(m).padStart(2, "0")}:${s}`;
  }
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = (total - m * 60).toFixed(2).padStart(5, "0");
    return `${m}:${s}`;
  }
  return total.toFixed(2);
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function getDistanceById(id) {
  return DISTANCES.find((d) => d.id === id);
}

function getDistanceByMeters(m) {
  return DISTANCES.find((d) => Math.abs(d.meters - m) < 0.01);
}

function defaultRiegelExponent(meters, profile) {
  if (meters <= 400) return 1.07;
  if (meters <= 3000) return profile === "sprinter" ? 1.075 : 1.07;
  if (meters <= 10000) return 1.06;
  return 1.065;
}

function interpPercentileBand(band, percentile) {
  const p = clamp(percentile, 0.25, 0.9);
  if (p <= 0.5) {
    const t = (p - 0.25) / 0.25;
    return band.p25 + t * (band.median - band.p25);
  }
  if (p <= 0.75) {
    const t = (p - 0.5) / 0.25;
    return band.median + t * (band.p75 - band.median);
  }
  const t = (p - 0.75) / 0.15;
  return band.p75 + t * (band.p90 - band.p75);
}

function riegelPredict(time1, d1, d2, exponent) {
  return time1 * Math.pow(d2 / d1, exponent);
}

function localExponent(t1, d1, t2, d2) {
  return Math.log(t2 / t1) / Math.log(d2 / d1);
}

function localPowerInterpolate(target, left, right) {
  const b = localExponent(left.time, left.meters, right.time, right.meters);
  return left.time * Math.pow(target / left.meters, b);
}

function fitCriticalSpeed(trials) {
  if (!trials || trials.length < 2) return null;
  const usable = trials
    .filter((x) => x.meters >= 800 && x.meters <= 10000 && x.time >= 100)
    .sort((a, b) => a.meters - b.meters);
  if (usable.length < 2) return null;

  const xs = usable.map((x) => x.time);
  const ys = usable.map((x) => x.meters);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;

  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (!den) return null;

  const cs = num / den;
  const arc = meanY - cs * meanX;
  if (!Number.isFinite(cs) || !Number.isFinite(arc) || cs <= 0) return null;
  return { cs, arc };
}

function predictFromCriticalSpeed(targetMeters, csFit) {
  if (!csFit) return null;
  const t = (targetMeters - csFit.arc) / csFit.cs;
  return t > 0 ? t : null;
}

function vdotFromPerformance(meters, timeSeconds) {
  if (!meters || !timeSeconds || meters < 1500) return null;
  const tMin = timeSeconds / 60;
  const velocity = meters / tMin;
  const vo2 = -4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity;
  const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
  const vdot = vo2 / frac;
  return Number.isFinite(vdot) ? vdot : null;
}

function predictTimeFromVDOT(targetMeters, vdot) {
  if (!vdot || targetMeters < 1500) return null;
  let lo = targetMeters / 8;
  let hi = targetMeters / 2;
  for (let i = 0; i < 70; i += 1) {
    const mid = (lo + hi) / 2;
    const tMin = mid / 60;
    const velocity = targetMeters / tMin;
    const vo2 = -4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity;
    const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
    const val = vo2 / frac;
    if (val > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function weightedAverage(candidates) {
  const valid = candidates.filter((x) => x && Number.isFinite(x.time) && x.weight > 0);
  if (!valid.length) return null;
  const weight = valid.reduce((sum, x) => sum + x.weight, 0);
  const time = valid.reduce((sum, x) => sum + x.time * x.weight, 0) / weight;
  return { time, methods: valid.map((x) => x.method), candidates: valid };
}

function nearestProvided(targetMeters, performances) {
  const arr = Object.values(performances).filter((p) => p && Number.isFinite(p.time));
  if (!arr.length) return null;
  return arr.slice().sort((a, b) => Math.abs(a.meters - targetMeters) - Math.abs(b.meters - targetMeters))[0];
}

function buildCanonicalPerformances(form) {
  const perf = {};
  DISTANCES.forEach((d) => {
    const raw = parseTimeToSeconds(form[d.id]);
    if (raw == null) return;
    perf[d.id] = { id: d.id, meters: d.meters, time: raw, source: "input" };
  });
  return perf;
}

function predictNeighborByKsA(performances, fromMeters, toMeters, percentile = 0.5) {
  const pair = `${fromMeters}/${toMeters}`;
  const band = KSA_TABLE[pair];
  const fromDist = getDistanceByMeters(fromMeters);
  if (!band || !fromDist || !performances[fromDist.id]) return null;
  const fromTime = performances[fromDist.id].time;
  const ksa = interpPercentileBand(band, percentile);
  return (fromTime * (toMeters / fromMeters)) / ksa;
}

function buildAnchorPredictions(performances, profile) {
  const anchors = {};
  DISTANCES.forEach((d) => {
    if (performances[d.id]) anchors[d.meters] = performances[d.id].time;
  });

  if (!anchors[200] && anchors[100]) anchors[200] = predictNeighborByKsA(performances, 100, 200, 0.5);
  if (!anchors[400] && anchors[200]) anchors[400] = predictNeighborByKsA({ ...performances, 200: { id: "200", meters: 200, time: anchors[200] } }, 200, 400, 0.5);
  if (!anchors[800] && anchors[400]) anchors[800] = predictNeighborByKsA({ ...performances, 400: { id: "400", meters: 400, time: anchors[400] } }, 400, 800, 0.5);
  if (!anchors[1500] && anchors[800]) anchors[1500] = predictNeighborByKsA({ ...performances, 800: { id: "800", meters: 800, time: anchors[800] } }, 800, 1500, 0.5);

  if (!anchors[300] && anchors[200] && anchors[400]) anchors[300] = localPowerInterpolate(300, { meters: 200, time: anchors[200] }, { meters: 400, time: anchors[400] });
  if (!anchors[600] && anchors[400] && anchors[800]) anchors[600] = localPowerInterpolate(600, { meters: 400, time: anchors[400] }, { meters: 800, time: anchors[800] });
  if (!anchors[1000] && anchors[800] && anchors[1500]) anchors[1000] = localPowerInterpolate(1000, { meters: 800, time: anchors[800] }, { meters: 1500, time: anchors[1500] });
  if (!anchors[1609.344] && anchors[1500] && (anchors[3000] || anchors[5000])) {
    const upper = anchors[3000] ? { meters: 3000, time: anchors[3000] } : { meters: 5000, time: anchors[5000] };
    anchors[1609.344] = localPowerInterpolate(1609.344, { meters: 1500, time: anchors[1500] }, upper);
  }
  if (!anchors[2000] && anchors[1500] && (anchors[3000] || anchors[5000])) {
    const upper = anchors[3000] ? { meters: 3000, time: anchors[3000] } : { meters: 5000, time: anchors[5000] };
    anchors[2000] = localPowerInterpolate(2000, { meters: 1500, time: anchors[1500] }, upper);
  }
  if (!anchors[3000] && anchors[1500]) anchors[3000] = riegelPredict(anchors[1500], 1500, 3000, defaultRiegelExponent(3000, profile));
  if (!anchors[3218.688] && anchors[3000] && anchors[5000]) anchors[3218.688] = localPowerInterpolate(3218.688, { meters: 3000, time: anchors[3000] }, { meters: 5000, time: anchors[5000] });
  if (!anchors[5000] && anchors[3000]) anchors[5000] = riegelPredict(anchors[3000], 3000, 5000, defaultRiegelExponent(5000, profile));
  if (!anchors[10000] && anchors[5000]) anchors[10000] = riegelPredict(anchors[5000], 5000, 10000, defaultRiegelExponent(10000, profile));
  if (!anchors[21097.5] && anchors[10000]) anchors[21097.5] = riegelPredict(anchors[10000], 10000, 21097.5, defaultRiegelExponent(21097.5, profile));
  if (!anchors[42195] && (anchors[21097.5] || anchors[10000])) {
    anchors[42195] = anchors[21097.5]
      ? riegelPredict(anchors[21097.5], 21097.5, 42195, defaultRiegelExponent(42195, profile))
      : riegelPredict(anchors[10000], 10000, 42195, defaultRiegelExponent(42195, profile));
  }
  return anchors;
}

function inferCurrentSprintPercentile(performances) {
  if (!performances["100"] || !performances["200"]) return 0.5;
  const observed = performances["100"].time / (performances["200"].time / 2);
  const band = KSA_TABLE["100/200"];
  const spread = Math.max(band.p75 - band.p25, 0.0001);
  const normalized = (observed - band.median) / spread;
  return clamp(0.5 + normalized * 0.4, 0.25, 0.9);
}

function classifyAthleteProfile({ profile, performances, speedScore, enduranceScore, speedEnduranceScore }) {
  const t100 = performances["100"]?.time ?? null;
  const t200 = performances["200"]?.time ?? null;
  const t400 = performances["400"]?.time ?? null;
  const t800 = performances["800"]?.time ?? null;
  const t1500 = performances["1500"]?.time ?? null;
  const t3000 = performances["3000"]?.time ?? null;
  const t5000 = performances["5000"]?.time ?? null;
  const t10000 = performances["10000"]?.time ?? null;

  const sprintBalance = t100 && t200 ? t200 - 2 * t100 : null;
  const longSprintDecay = t200 && t400 ? t400 / (2 * t200) : null;
  const oneLapToTwoLap = t400 && t800 ? t800 / (2 * t400) : null;
  const twoLapTo1500 = t800 && t1500 ? t1500 / (t800 * (1500 / 800)) : null;
  const enduranceSlope = t3000 && t5000 ? Math.log(t5000 / t3000) / Math.log(5000 / 3000) : null;
  const longEnduranceSlope = t5000 && t10000 ? Math.log(t10000 / t5000) / Math.log(10000 / 5000) : null;

  if (profile === "sprinter") {
    if (sprintBalance != null && sprintBalance < 0.75 && longSprintDecay != null && longSprintDecay > 1.13) {
      return { type: "Pure Speed Sprinter", summary: "Your profile leans heavily toward raw speed and acceleration more than fatigue resistance." };
    }
    if (longSprintDecay != null && longSprintDecay <= 1.11) {
      return { type: "Speed-Endurance Sprinter", summary: "You look more like a long sprinter who can carry race pace better than most." };
    }
    if (oneLapToTwoLap != null && oneLapToTwoLap < 1.84) {
      return { type: "One-Lap / Two-Lap Hybrid", summary: "Your marks suggest that your speed stretches upward into the 800m range better than typical sprinters." };
    }
    return { type: "Balanced Sprinter", summary: "Your sprint profile looks fairly even, without one quality massively dominating the others." };
  }

  if (profile === "middle") {
    if (oneLapToTwoLap != null && oneLapToTwoLap < 1.82) {
      return { type: "Speed-Leaning Middle Runner", summary: "Your middle-distance profile appears to be supported strongly by raw pace and short-race speed." };
    }
    if (twoLapTo1500 != null && twoLapTo1500 <= 1.03 && enduranceScore >= speedScore) {
      return { type: "Aerobic Middle Runner", summary: "Your results suggest that aerobic support and pace durability are major strengths in your event range." };
    }
    if (speedEnduranceScore >= 78 || (oneLapToTwoLap != null && oneLapToTwoLap >= 1.82 && oneLapToTwoLap <= 1.89)) {
      return { type: "Middle-Distance Hybrid", summary: "You look like a classic hybrid profile: enough speed to matter, enough support to hold quality late." };
    }
    return { type: "Balanced Middle Runner", summary: "Your middle-distance profile looks broadly balanced and trainable in more than one direction." };
  }

  if (enduranceSlope != null && enduranceSlope <= 1.055 && speedScore >= 62) {
    return { type: "Speed-Supported Distance Runner", summary: "Your distance profile seems to benefit from having better speed support than many pure endurance runners." };
  }
  if ((enduranceSlope != null && enduranceSlope > 1.055) || (longEnduranceSlope != null && longEnduranceSlope > 1.06)) {
    return { type: "Strength-Based Distance Runner", summary: "Your profile looks more strength-and-endurance based than speed-based, especially as the distance rises." };
  }
  if (enduranceScore >= 78) {
    return { type: "Endurance Engine", summary: "Your numbers point toward a strong aerobic base and a profile that should scale well across longer races." };
  }
  return { type: "Balanced Distance Runner", summary: "Your distance profile looks relatively even, without one trait clearly overpowering the others." };
}

function buildStrengthsAndNeeds({ profile, athleteType, untapped }) {
  const strengths = [];
  const needs = [];

  if (profile === "sprinter") {
    if (athleteType === "Pure Speed Sprinter") {
      strengths.push("Your short sprint profile suggests real raw speed and acceleration upside.");
      strengths.push("You are likely strongest when races are decided by pure pace rather than by fatigue tolerance.");
      needs.push("Your biggest gains probably come from speed endurance and how well you hold mechanics after halfway.");
      needs.push("You would benefit from more 150m to 350m work that teaches you to resist deceleration.");
    } else if (athleteType === "Speed-Endurance Sprinter") {
      strengths.push("You seem better than average at carrying sprint speed into the later part of the race.");
      strengths.push("Your profile fits the long sprint range well, especially when rhythm matters.");
      needs.push("The next level is likely about sharpening top speed without losing your endurance advantage.");
      needs.push("You would benefit from keeping maximal velocity work in the program while protecting long-sprint quality.");
    } else if (athleteType === "One-Lap / Two-Lap Hybrid") {
      strengths.push("Your profile suggests your speed can stretch upward better than most pure sprinters.");
      strengths.push("That kind of crossover profile often responds well to mixed sprint and special-endurance training.");
      needs.push("Your next gains likely come from deciding whether to lean more fully into 400m or 800m specific work.");
      needs.push("You would benefit from sessions that improve both controlled pace and late-race composure.");
    } else {
      strengths.push("Your sprint profile looks fairly balanced across speed and fatigue resistance.");
      strengths.push("That gives you more than one way to improve depending on the event you target most.");
      needs.push("The biggest gains will usually come from whichever sprint quality gets the most consistent attention.");
      needs.push("You would benefit from a clearer split between raw speed days and race-specific endurance days.");
    }
  } else if (profile === "middle") {
    if (athleteType === "Speed-Leaning Middle Runner") {
      strengths.push("Your middle-distance profile is being supported strongly by pace and shorter-race speed.");
      strengths.push("That usually gives you tactical flexibility and a sharper top gear than more aerobic runners.");
      needs.push("Your next ceiling is likely set by aerobic support and how calmly you can hold pace late in the race.");
      needs.push("You would benefit from more aerobic power work and pace-stability sessions.");
    } else if (athleteType === "Aerobic Middle Runner") {
      strengths.push("Your profile suggests that aerobic support and race durability are real strengths.");
      strengths.push("That often makes you more stable across rounds and more resilient late in the event.");
      needs.push("Your clearest gains may come from upgrading raw speed and gear-change ability.");
      needs.push("You would benefit from more neuromuscular speed work and sharper event-specific finishing sessions.");
    } else if (athleteType === "Middle-Distance Hybrid") {
      strengths.push("You look like a classic middle-distance hybrid with useful speed and enough support to hold it.");
      strengths.push("This is one of the most believable all-around middle-distance profiles.");
      needs.push("Your next gains likely come from event precision rather than from only training one physical system harder.");
      needs.push("You would benefit from sessions that connect pace judgement, positioning, and finishing speed.");
    } else {
      strengths.push("Your middle-distance profile looks balanced and adaptable.");
      strengths.push("That gives you room to develop in either a speed-first or aerobic-first direction.");
      needs.push("The biggest gains probably come once the training leans more clearly toward one event identity.");
      needs.push("You would benefit from a more event-specific mix of speed support and aerobic structure.");
    }
  } else {
    if (athleteType === "Speed-Supported Distance Runner") {
      strengths.push("Your distance profile seems to be helped by better-than-average speed support.");
      strengths.push("That often makes you more dangerous in races that require rhythm changes or a faster finish.");
      needs.push("Your next gains likely come from preserving that speed while making the endurance curve more stable.");
      needs.push("You would benefit from more threshold durability and race-specific long intervals.");
    } else if (athleteType === "Strength-Based Distance Runner") {
      strengths.push("Your profile looks more strength-and-endurance based than speed based.");
      strengths.push("That often supports solid long-race durability and consistent pacing.");
      needs.push("Your next ceiling may be limited by lack of speed support rather than lack of endurance.");
      needs.push("You would benefit from faster controlled work and from protecting leg speed year-round.");
    } else if (athleteType === "Endurance Engine") {
      strengths.push("Your numbers point toward a strong aerobic base that should scale well across longer races.");
      strengths.push("That kind of profile usually handles volume and pace durability better than average.");
      needs.push("Your best next gains are often about improving efficiency and adding enough speed to change gears late.");
      needs.push("You would benefit from threshold work that stays economical plus one faster session that protects turnover.");
    } else {
      strengths.push("Your distance profile looks relatively even across endurance and support qualities.");
      strengths.push("That gives you a stable base for improvement without forcing one narrow race identity.");
      needs.push("The next step is usually making the pace curve smoother as the race distance rises.");
      needs.push("You would benefit from clearer event-specific pacing practice and stronger fatigue resistance at race rhythm.");
    }
  }

  if (untapped > 0) {
    needs.push("Because the model sees measurable upside, better specificity and cleaner race execution could move your result noticeably.");
  }

  return { strengths: strengths.slice(0, 3), needs: needs.slice(0, 3) };
}

function buildShortFeedback({
  profile,
  target,
  athleteType,
  athleteTypeSummary,
  strengths,
  needs,
  untapped,
  speedScore,
  enduranceScore,
  speedEnduranceScore,
  training,
  age,
}) {
  const ageValue = Number(age);
  const trainingValue = Number(training);

  const eventLens =
    profile === "sprinter"
      ? "For this sprint target, the model mainly focuses on raw speed, pace retention, and how sharply performance fades late in the race."
      : profile === "middle"
        ? "For this middle-distance target, the model mainly looks for balance between speed support, aerobic control, and how well your profile scales upward."
        : "For this endurance target, the model mainly looks at how smoothly your performances scale as the distance rises and how stable your aerobic profile appears.";

  const scoreLine =
    profile === "sprinter"
      ? `Your current score pattern looks like Speed ${speedScore}/100 and Speed Endurance ${speedEnduranceScore}/100, which fits the ${athleteType} label quite well.`
      : profile === "middle"
        ? `Your current score pattern looks like Speed ${speedScore}/100, Endurance ${enduranceScore}/100, and Speed Endurance ${speedEnduranceScore}/100, which matches the ${athleteType} profile.`
        : `Your current score pattern leans most on Endurance ${enduranceScore}/100 with supporting Speed ${speedScore}/100, which fits the ${athleteType} identity.`;

  const gapLine =
    untapped > 1.5
      ? `Right now the gap to the projected ${target.label} upside is fairly meaningful, which suggests there is still real room to move if the training points in the right direction.`
      : untapped > 0.5
        ? `The gap to the projected ${target.label} upside is moderate, so this looks more like a realistic refinement project than a complete rebuild.`
        : `You already look fairly close to the projected ${target.label} level, so this is more about precision and small gains than huge missing potential.`;

  const trainingLine =
    trainingValue >= 6
      ? "Your current training frequency already looks solid, so the next gains probably depend more on session quality and event specificity than on simply doing more."
      : trainingValue >= 3
        ? "Your weekly training pattern looks workable, which means consistency and sharper event-specific sessions could still unlock noticeable progress."
        : "Because your current training frequency looks modest, a more stable week-to-week structure could improve the prediction faster than complicated fine-tuning.";

  const ageLine =
    Number.isFinite(ageValue) && ageValue > 0
      ? ageValue <= 19
        ? "Given your age, the profile should still be quite responsive to technical gains and better event-specific training."
        : ageValue <= 29
          ? "At your age, the biggest changes usually come from sharpening the right qualities rather than rebuilding everything."
          : "At your age, the most useful path is usually to protect your best quality while improving efficiency around it."
      : "The model can still give useful direction even without using age as a major driver.";

  return {
    headline: `${athleteType} for ${target.label}`,
    summary: athleteTypeSummary,
    body: [
      eventLens,
      scoreLine,
      `Your clearest strength right now is that ${strengths[0]?.charAt(0).toLowerCase() + strengths[0]?.slice(1)}`,
      `The main area to improve next is that ${needs[0]?.charAt(0).toLowerCase() + needs[0]?.slice(1)}`,
      gapLine,
      trainingLine,
      ageLine,
    ].join(" "),
  };
}

function buildConfidenceLabel(methodCount, low, high, currentTime) {
  const spreadRatio = currentTime > 0 ? (high - low) / currentTime : 1;
  if (methodCount >= 4 && spreadRatio < 0.05) return "High";
  if (methodCount >= 3 && spreadRatio < 0.09) return "Moderate";
  return "Exploratory";
}

function buildPrediction(targetId, profile, form) {
  const target = getDistanceById(targetId);
  if (!target) return null;

  const performances = buildCanonicalPerformances(form);
  delete performances[targetId];
  const provided = Object.values(performances);
  if (!provided.length) return null;

  const anchors = buildAnchorPredictions(performances, profile);
  const targetMeters = target.meters;
  const currentPercentile = inferCurrentSprintPercentile(performances);
  const csFit = fitCriticalSpeed(provided);
  const vdotList = provided.map((p) => vdotFromPerformance(p.meters, p.time)).filter(Boolean);
  const vdot = vdotList.length ? vdotList.reduce((a, b) => a + b, 0) / vdotList.length : null;

  const candidates = [];
  const optimisticCandidates = [];

  if (targetMeters === 200 && performances["100"]) {
    const band = KSA_TABLE["100/200"];
    const currentKsA = interpPercentileBand(band, currentPercentile);
    const potentialKsA = interpPercentileBand(band, 0.9);
    candidates.push({ time: (performances["100"].time * 2) / currentKsA, weight: 4, method: "100→200 KsA conversion" });
    optimisticCandidates.push({ time: (performances["100"].time * 2) / potentialKsA, weight: 4, method: "100→200 high-end KsA band" });
  }

  if (targetMeters === 400 && performances["200"]) {
    const band = KSA_TABLE["200/400"];
    const currentKsA = interpPercentileBand(band, currentPercentile);
    const potentialKsA = interpPercentileBand(band, 0.9);
    candidates.push({ time: (performances["200"].time * 2) / currentKsA, weight: 5, method: "200→400 KsA core model" });
    optimisticCandidates.push({ time: (performances["200"].time * 2) / potentialKsA, weight: 5, method: "200→400 strong special-endurance band" });
  }

  if (targetMeters === 800 && performances["400"]) {
    const band = KSA_TABLE["400/800"];
    candidates.push({ time: (performances["400"].time * 2) / interpPercentileBand(band, 0.5), weight: 4, method: "400→800 KsA conversion" });
    optimisticCandidates.push({ time: (performances["400"].time * 2) / interpPercentileBand(band, 0.9), weight: 4, method: "400→800 high-end KsA band" });
  }

  if (targetMeters === 1500 && performances["800"]) {
    const band = KSA_TABLE["800/1500"];
    candidates.push({ time: (performances["800"].time * (1500 / 800)) / interpPercentileBand(band, 0.5), weight: 4, method: "800→1500 KsA conversion" });
    optimisticCandidates.push({ time: (performances["800"].time * (1500 / 800)) / interpPercentileBand(band, 0.9), weight: 4, method: "800→1500 high-end KsA band" });
  }

  const anchorDistances = Object.entries(anchors)
    .map(([meters, time]) => ({ meters: Number(meters), time }))
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.meters - b.meters);
  const lower = anchorDistances.filter((x) => x.meters < targetMeters).slice(-1)[0] || null;
  const upper = anchorDistances.find((x) => x.meters > targetMeters) || null;

  if (lower && upper) {
    candidates.push({ time: localPowerInterpolate(targetMeters, lower, upper), weight: 3.5, method: `Local interpolation between ${lower.meters}m and ${upper.meters}m` });
    optimisticCandidates.push({ time: localPowerInterpolate(targetMeters, { ...lower, time: lower.time * 0.99 }, { ...upper, time: upper.time * 0.985 }), weight: 3, method: "Optimistic local interpolation" });
  }

  const nearest = nearestProvided(targetMeters, performances);
  if (nearest) {
    const exp = defaultRiegelExponent(targetMeters, profile);
    const closeness = 1 / (1 + Math.abs(Math.log(targetMeters / nearest.meters)));
    const nearestLabel = nearest.meters >= 1000 ? `${(nearest.meters / 1000).toFixed(nearest.meters % 1000 === 0 ? 0 : 1)}k-ish anchor` : `${nearest.meters}m`;
    candidates.push({ time: riegelPredict(nearest.time, nearest.meters, targetMeters, exp), weight: 1.8 + closeness, method: `Riegel projection from ${nearestLabel}` });
    optimisticCandidates.push({ time: riegelPredict(nearest.time, nearest.meters, targetMeters, Math.max(exp - 0.015, 1.03)), weight: 1.7 + closeness, method: "Optimistic fatigue-factor projection" });
  }

  if (targetMeters >= 800 && targetMeters <= 10000) {
    const csTime = predictFromCriticalSpeed(targetMeters, csFit);
    if (csTime) {
      candidates.push({ time: csTime, weight: 3, method: "Critical speed model" });
      optimisticCandidates.push({ time: csTime * 0.985, weight: 2.5, method: "Critical speed with small upside" });
    }
  }

  if (targetMeters >= 1500 && vdot) {
    const vdotTime = predictTimeFromVDOT(targetMeters, vdot);
    if (vdotTime) {
      candidates.push({ time: vdotTime, weight: targetMeters >= 5000 ? 3.2 : 2.4, method: "VDOT endurance model" });
      optimisticCandidates.push({ time: predictTimeFromVDOT(targetMeters, vdot * 1.02), weight: targetMeters >= 5000 ? 2.8 : 2, method: "VDOT with small aerobic upside" });
    }
  }

  const current = weightedAverage(candidates);
  const potential = weightedAverage(optimisticCandidates);
  if (!current) return null;

  const candidateTimes = current.candidates.map((x) => x.time).sort((a, b) => a - b);
  const low = candidateTimes[Math.floor(candidateTimes.length * 0.2)] ?? current.time;
  const high = candidateTimes[Math.floor(candidateTimes.length * 0.8)] ?? current.time;
  const potentialTime = potential ? Math.min(potential.time, current.time * 0.992, current.time - Math.max(current.time * 0.01, 0.15)) : current.time * 0.99;

  const speedScore = performances["100"] ? clamp(Math.round((12.8 - performances["100"].time) * 38), 35, 98) : targetMeters <= 400 ? 72 : 58;
  const enduranceBase = performances["5000"] ? performances["5000"].time : performances["3000"]?.time ? performances["3000"].time * 1.7 : performances["800"]?.time ? performances["800"].time * 4.2 : null;
  const enduranceScore = enduranceBase ? clamp(Math.round((1400 - enduranceBase) / 9), 35, 96) : targetMeters >= 1500 ? 72 : 58;
  const speedEnduranceScore = performances["200"] && performances["400"] ? clamp(Math.round((((performances["200"].time * 2) / performances["400"].time) - 0.88) * 250), 40, 97) : targetMeters === 400 || targetMeters === 800 ? 74 : 62;

  const athleteProfile = classifyAthleteProfile({ profile, performances, speedScore, enduranceScore, speedEnduranceScore });
  const athleteType = athleteProfile.type;
  const athleteTypeSummary = athleteProfile.summary;
  const untapped = Math.max(current.time - potentialTime, 0);
  const { strengths, needs } = buildStrengthsAndNeeds({ profile, athleteType, untapped });
  const previewLine = `${strengths[0]} ${needs[0]}`;
  const shortFeedback = buildShortFeedback({
    profile,
    target,
    athleteType,
    athleteTypeSummary,
    strengths,
    needs,
    untapped,
    speedScore,
    enduranceScore,
    speedEnduranceScore,
    training: form.training,
    age: form.age,
  });

  const aiFeedback = `Your selected target is ${target.label}. Based on the performances you entered, the model estimates a realistic current level around ${formatSeconds(current.time)} and a stronger but still bounded upside around ${formatSeconds(potentialTime)}. That creates an estimated headroom of ${untapped.toFixed(2)} seconds.\n\nYour strongest current qualities appear to be these: ${strengths.join(" ")}\n\nThe most useful areas to train next are these: ${needs.join(" ")}\n\nModel choice matters here. For this event, RacePotential leaned most heavily on ${current.methods.slice(0, 3).join(", ")}. That means the result is not just one formula stretched across all distances. It is a blended estimate built from sprint-conversion logic, local interpolation, and endurance-specific models when the target event demands it.\n\nIf I were coaching the next block for this target, I would focus on one session that protects your current strength, one session that attacks your biggest limiter, and one session that improves race execution for the exact distance you selected.`;

  return {
    target,
    currentTime: current.time,
    potentialTime,
    low,
    high,
    confidence: buildConfidenceLabel(current.methods.length, low, high, current.time),
    uncertainty: ((high - low) / 2).toFixed(2),
    speedScore,
    enduranceScore,
    speedEnduranceScore,
    athleteType,
    athleteTypeSummary,
    untapped,
    strengths,
    needs,
    previewLine,
    shortFeedback,
    aiFeedback,
    methods: current.methods,
  };
}

function getEquivalentAdjustmentSeconds(meters, profile, form) {
  const has400 = parseTimeToSeconds(form["400"]) != null;
  const has800 = parseTimeToSeconds(form["800"]) != null;
  const has1500 = parseTimeToSeconds(form["1500"]) != null;
  const supportCount = [has400, has800, has1500].filter(Boolean).length;

  const middleBase = {
    400: 1.5,
    600: 3.0,
    800: 1.5,
    1000: 1.0,
  };

  const sprinterBase = {
    200: 0.35,
    300: 0.8,
    400: 1.0,
    600: 1.8,
    800: 1.1,
    1000: 0.7,
  };

  const distanceBase = {
    800: 0.8,
    1000: 0.6,
    1500: 0.4,
  };

  const base =
    profile === "middle"
      ? middleBase[meters] || 0
      : profile === "sprinter"
        ? sprinterBase[meters] || 0
        : distanceBase[meters] || 0;

  if (!base) return 0;

  const supportMultiplier = supportCount >= 2 ? 1 : supportCount === 1 ? 0.85 : 0.7;
  return base * supportMultiplier;
}

function buildEquivalentPerformances(targetId, profile, form) {
  const eligible = DISTANCES.filter((d) => {
    if (profile === "sprinter") return d.meters <= 800;
    if (profile === "middle") return d.meters >= 400 && d.meters <= 3000;
    return d.meters >= 1500;
  }).filter((d) => d.id !== targetId);

  return eligible
    .map((d) => {
      const prediction = buildPrediction(d.id, profile, form);
      if (!prediction) return null;
      const tunedTime = Math.max(
        prediction.currentTime - getEquivalentAdjustmentSeconds(d.meters, profile, form),
        prediction.currentTime * 0.94,
      );
      return {
        id: d.id,
        label: d.label,
        meters: d.meters,
        time: tunedTime,
        confidence: prediction.confidence,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.meters - b.meters);
}

function buildBestEventRanking(profile, form) {
  const pool = DISTANCES.filter((d) => {
    if (profile === "sprinter") return d.meters <= 800;
    if (profile === "middle") return d.meters >= 400 && d.meters <= 3000;
    return d.meters >= 1500;
  });

  return pool
    .map((d) => {
      const prediction = buildPrediction(d.id, profile, form);
      if (!prediction) return null;
      const profileMatch =
        profile === "sprinter"
          ? d.meters <= 400 ? 1 : 0.92
          : profile === "middle"
            ? d.meters >= 600 && d.meters <= 1500 ? 1 : 0.94
            : d.meters >= 5000 ? 1 : 0.94;
      const sharpness = 1 - ((prediction.high - prediction.low) / Math.max(prediction.currentTime, 1));
      const upsideControl = 1 - clamp(prediction.untapped / Math.max(prediction.currentTime, 1), 0, 0.12) * 2;
      return { id: d.id, label: d.label, score: profileMatch * 0.5 + sharpness * 0.3 + upsideControl * 0.2 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function getProcessState({ targetId, form, visibleInputs, result }) {
  const step1Complete = Boolean(targetId);
  const step2Complete = String(form.age || "").trim() !== "" && String(form.training || "").trim() !== "";
  const filledPerformanceCount = visibleInputs.filter((d) => String(form[d.id] || "").trim() !== "").length;
  const step3Complete = filledPerformanceCount > 0;
  const step4Complete = Boolean(result);
  return {
    step1: step1Complete ? "done" : "current",
    step2: !step1Complete ? "upcoming" : step2Complete ? "done" : "current",
    step3: !step2Complete ? "upcoming" : step3Complete ? "done" : "current",
    step4: !step3Complete ? "upcoming" : step4Complete ? "done" : "current",
    filledPerformanceCount,
  };
}

function processClasses(state) {
  if (state === "done") {
    return {
      card: "border-red-400/25 bg-gradient-to-br from-red-500/12 to-white/[0.04] shadow-lg shadow-red-500/10",
      pill: "bg-red-500/15 text-red-200 border-red-400/25",
      title: "text-white",
      text: "text-white/70",
      dot: "bg-red-400",
    };
  }
  if (state === "current") {
    return {
      card: "border-white/15 bg-white/[0.06] ring-1 ring-white/10 shadow-lg shadow-black/20",
      pill: "bg-white/10 text-white border-white/15",
      title: "text-white",
      text: "text-white/75",
      dot: "bg-white",
    };
  }
  return {
    card: "border-white/10 bg-white/[0.03]",
    pill: "bg-transparent text-white/45 border-white/10",
    title: "text-white/70",
    text: "text-white/45",
    dot: "bg-white/25",
  };
}

function RacePotentialLogo({ size = 42 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <circle cx="50" cy="50" r="46" stroke="#ef4444" strokeWidth="6" />
        <path d="M25 60 L45 40 L60 55 L78 35" stroke="#ef4444" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="78" cy="35" r="4" fill="#ef4444" />
      </svg>
      <div style={{ fontWeight: 700, fontSize: 20, letterSpacing: 1 }}>RacePotential</div>
    </div>
  );
}

function StepSectionHeader({ step, title, description, children, className = "" }) {
  return (
    <div className={`rounded-[28px] border border-red-400/20 bg-gradient-to-br from-red-500/10 to-white/[0.03] p-5 shadow-lg shadow-red-500/5 ${className}`}>
      <div className="text-xs uppercase tracking-[0.22em] text-white/45">{step}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{title}</div>
      {description ? <p className="mt-2 text-sm leading-6 text-white/65">{description}</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function buildTrainingAdvice(result, profile, form) {
  if (!result) return [];

  const sessionsPerWeek = Number(form?.training || 0);
  const needsText = (result.needs || []).join(" ").toLowerCase();
  const strengthText = (result.strengths || []).join(" ").toLowerCase();

  const limiter =
    needsText.includes("aerobic") || needsText.includes("endurance") || needsText.includes("threshold")
      ? "aerobic support"
      : needsText.includes("speed endurance") || needsText.includes("late") || needsText.includes("fatigue")
        ? "speed endurance"
        : needsText.includes("speed") || needsText.includes("acceleration") || needsText.includes("gear-change")
          ? "raw speed"
          : profile === "distance"
            ? "aerobic support"
            : profile === "sprinter"
              ? "speed endurance"
              : "race-specific endurance";

  const primarySession =
    profile === "sprinter"
      ? limiter === "raw speed"
        ? {
            title: "Primary session: acceleration + max velocity",
            goal: "Improve raw speed so your race ceiling rises, not just your fatigue tolerance.",
            prescription: "2 sets of 3 × 40m from a rolling or 3-point start, then 3 × 60m fast and relaxed. Take 2–3 min between reps and 6 min between sets.",
            coaching: "Stop the rep if mechanics tighten. The goal is quality, not exhaustion.",
          }
        : {
            title: "Primary session: speed endurance",
            goal: "Improve how well you hold pace after the first half of the race.",
            prescription: "4 × 200m at 92–95% effort with 6–8 min recovery, or 3 × 300m with full recovery if your main event is 400m.",
            coaching: "Keep the final 50m controlled and technically clean instead of straining early.",
          }
      : profile === "middle"
        ? limiter === "aerobic support"
          ? {
              title: "Primary session: threshold support",
              goal: "Raise your aerobic floor so you can arrive at race pace with less strain.",
              prescription: "5 × 1km at controlled threshold effort with 75–90 sec recovery, or 20–25 min continuous tempo if you prefer steady work.",
              coaching: "This should feel strong but repeatable. You should finish feeling like you could do one more rep.",
            }
          : limiter === "raw speed"
            ? {
                title: "Primary session: speed support",
                goal: "Improve top-end pace and change-of-gear ability for faster middle-distance racing.",
                prescription: "2 sets of 4 × 150m fast but relaxed with walk-back recovery and 4–5 min between sets.",
                coaching: "Focus on rhythm and relaxed mechanics rather than forcing the rep.",
              }
            : {
                title: "Primary session: race pace endurance",
                goal: "Improve your ability to tolerate goal pace and stay composed late in the race.",
                prescription: "5 × 400m at projected race pace with 2:00–2:30 recovery, or 3 × 600m at target rhythm with 3–4 min recovery.",
                coaching: "The priority is even splits. If you go out too hard, the session misses the point.",
              }
        : limiter === "raw speed"
          ? {
              title: "Primary session: economy + leg speed",
              goal: "Protect speed support so your endurance profile does not become one-paced.",
              prescription: "10 × 200m at 3k–5k rhythm but relaxed, with 200m jog recovery, finishing with 4 × 100m strides.",
              coaching: "Stay smooth and quick. This is about economy, not forcing lactate.",
            }
          : {
              title: "Primary session: threshold development",
              goal: "Lift the aerobic system that most strongly limits your projected result.",
              prescription: "4–6 × 1km at threshold pace with 60–90 sec recovery, or 3 × 2km if you are stronger over longer work.",
              coaching: "This session should feel controlled from start to finish and never turn into an all-out interval workout.",
            };

  const secondarySessions =
    profile === "sprinter"
      ? [
          {
            title: "Secondary session: resisted starts or hill sprints",
            text: "6–10 × 10–20 seconds with full recovery to improve force application early in the race.",
          },
          {
            title: "Secondary session: strength & stiffness",
            text: "2 weekly gym sessions focused on posterior chain, split squats, RDLs, calf work, and trunk control.",
          },
        ]
      : profile === "middle"
        ? [
            {
              title: "Secondary session: aerobic support",
              text: "One continuous easy run or controlled threshold session each week to make race-specific work more repeatable.",
            },
            {
              title: "Secondary session: short speed maintenance",
              text: "4–8 × 80–120m relaxed fast running after easy days to keep mechanics sharp.",
            },
          ]
        : [
            {
              title: "Secondary session: long aerobic session",
              text: "A long run or extended steady run once per week to reinforce fatigue resistance and pacing control.",
            },
            {
              title: "Secondary session: faster aerobic intervals",
              text: "Sessions like 6 × 800m or 5 × 1km at 10k–5k effort improve oxygen uptake and race economy.",
            },
          ];

  const weeklyStructure =
    sessionsPerWeek >= 6
      ? [
          "Monday — primary quality session",
          "Tuesday — easy aerobic running + strides or mobility",
          "Wednesday — secondary support session",
          "Thursday — easy recovery",
          "Friday — race-specific or economy session",
          "Saturday — easy running or strength",
          "Sunday — long run / aerobic support",
        ]
      : sessionsPerWeek >= 4
        ? [
            "Day 1 — primary quality session",
            "Day 2 — easy recovery or strength",
            "Day 3 — secondary support session",
            "Day 4 — easy aerobic work or long run",
          ]
        : [
            "Day 1 — primary quality session",
            "Day 2 — easy aerobic run or cross-training",
            "Day 3 — short support session + mobility/strength",
          ];

  return {
    limiter,
    primarySession,
    secondarySessions,
    weeklyStructure,
    consistencyNote:
      sessionsPerWeek >= 5
        ? "Because your current training frequency already looks solid, your next gains should come from better session specificity and better recovery between hard days."
        : "Because your current training frequency is still moderate, consistency itself is likely one of the biggest upgrades available to you right now.",
    strengthLeverage:
      strengthText.includes("speed")
        ? "Your current strengths suggest you should protect speed while building the system that lets that speed last longer."
        : strengthText.includes("aerobic") || strengthText.includes("endurance")
          ? "Your current strengths suggest you should keep your aerobic base strong while sharpening the quality that helps you race faster, not just longer."
          : "Your profile looks balanced enough that a focused block can move the result without having to rebuild everything.",
  };
}

function buildFullPersonalizedReport(result, equivalents, profile, form) {
  if (!result) return "";

  const advice = buildTrainingAdvice(result, profile, form);
  const profileLabel = PROFILE_CONFIG[profile]?.label || "Runner";
  const age = String(form?.age || "").trim() || "not provided";
  const training = String(form?.training || "").trim() || "not provided";

  const equivalentsText = (equivalents || []).length
    ? (equivalents || []).map((e) => `- ${e.label}: ${formatSeconds(e.time)}`).join("\n")
    : "- Not enough data yet to generate strong equivalent performances.";

  const strengthsText = (result.strengths || []).map((s) => `- ${s}`).join("\n");
  const needsText = (result.needs || []).map((n) => `- ${n}`).join("\n");
  const weeklyText = advice.weeklyStructure.map((d) => `- ${d}`).join("\n");
  const secondaryText = advice.secondarySessions.map((s) => `- ${s.title}: ${s.text}`).join("\n");

  return [
    `${profileLabel} profile report for ${result.target.label}`,
    "",
    `Based on the performances you entered, RacePotential estimates your realistic current level around ${formatSeconds(result.currentTime)} and your stronger upside around ${formatSeconds(result.potentialTime)}. That creates an estimated headroom of ${result.untapped.toFixed(2)} seconds.`,
    "",
    `Your athlete type is ${result.athleteType}. ${result.athleteTypeSummary}`,
    "",
    `Your score profile currently looks like Speed ${result.speedScore}/100, Endurance ${result.enduranceScore}/100, and Speed Endurance ${result.speedEnduranceScore}/100. That score pattern is part of why the model places you in this athlete category and why it identifies your current limiter as ${advice.limiter}.`,
    "",
    "What the model thinks you already do well:",
    strengthsText,
    "",
    "What is holding you back most right now:",
    needsText,
    "",
    `Athlete context used: age ${age}, training frequency ${training} sessions per week. ${advice.consistencyNote}`,
    "",
    "Equivalent performances based on your current profile:",
    equivalentsText,
    "",
    "The clearest training conclusion:",
    advice.strengthLeverage,
    "",
    advice.primarySession.title,
    `Goal: ${advice.primarySession.goal}`,
    `Prescription: ${advice.primarySession.prescription}`,
    `Execution note: ${advice.primarySession.coaching}`,
    "",
    "Other session types that would support improvement:",
    secondaryText,
    "",
    "Suggested weekly structure:",
    weeklyText,
    "",
    "What to expect if you apply this well:",
    "If the next training block is built around the limiter identified above, most athletes with a similar profile improve not because they train harder every day, but because they train the right system often enough and recover well enough to absorb it.",
  ].join("\n");
}

function buildPdfReportLines(result, equivalents, profile, form) {
  const fullReport = buildFullPersonalizedReport(result, equivalents, profile, form);
  return fullReport.split("\n");
}

function PremiumReportSection({ result, equivalents, profile, form, isPaid, onUnlock, onDownloadPdf }) {
  if (!result) return null;

  const advice = buildTrainingAdvice(result, profile, form);
  const fullReport = buildFullPersonalizedReport(result, equivalents, profile, form);
  const reportParagraphs = fullReport.split("\n\n").filter(Boolean);

  return (
    <div className="mt-6 rounded-[28px] border border-red-400/20 bg-gradient-to-br from-red-500/10 to-white/[0.03] p-6 shadow-lg">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-red-200/80">Premium</div>
          <h3 className="mt-1 text-xl font-semibold">Full Performance Report</h3>
        </div>
        {!isPaid && (
          <button
            onClick={onUnlock}
            className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-red-500/20"
          >
            Unlock full report – $0.99
          </button>
        )}
      </div>

      {!isPaid && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
          <p className="text-sm leading-6 text-white/70">
            Unlock a detailed personalized report that explains what your results mean, why the model thinks you are currently limited where you are, and exactly what type of session would best improve your next result.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">Detailed AI-style performance interpretation</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">Equivalent performances across events</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">One high-impact session for your main limiter</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">4–8 week training structure idea + PDF report</div>
          </div>
          <div className="mt-4 rounded-xl border border-red-400/15 bg-red-500/10 p-4">
            <div className="text-sm font-medium text-white">Teaser</div>
            <p className="mt-2 text-sm leading-6 text-white/75">
              The model sees your biggest improvement opportunity in <span className="font-semibold text-white">{advice.limiter}</span>. The full report explains exactly why, and gives you a specific session to target it.
            </p>
          </div>
        </div>
      )}

      {isPaid && (
        <div className="mt-6 space-y-6">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-white/45">Predicted performance</div>
            <div className="mt-2 text-3xl font-semibold text-white">{result.target.label}: {formatSeconds(result.potentialTime)}</div>
            <div className="mt-2 text-sm leading-6 text-white/65">Realistic current level: {formatSeconds(result.currentTime)} · Headroom: {result.untapped.toFixed(2)} s · Confidence: {result.confidence}</div>
          </div>

          {!!equivalents?.length && (
            <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
              <div className="text-xs uppercase tracking-[0.18em] text-white/45">Equivalent performances</div>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {equivalents.map((eq) => (
                  <div key={eq.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <div className="text-sm text-white/70">{eq.label}</div>
                    <div className="text-lg font-semibold text-white">{formatSeconds(eq.time)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-white/45">Detailed report</div>
            <div className="mt-4 space-y-4">
              {reportParagraphs.map((paragraph, index) => (
                <div key={index} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="whitespace-pre-line text-sm leading-7 text-white/82">{paragraph}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-white/45">Specific session to improve your limiter</div>
            <div className="mt-3 rounded-xl border border-red-400/15 bg-red-500/10 p-4">
              <div className="text-lg font-semibold text-white">{advice.primarySession.title}</div>
              <div className="mt-2 text-sm leading-7 text-white/80">{advice.primarySession.goal}</div>
              <div className="mt-3 text-sm leading-7 text-white/90"><span className="font-semibold text-white">Prescription:</span> {advice.primarySession.prescription}</div>
              <div className="mt-2 text-sm leading-7 text-white/75"><span className="font-semibold text-white">Execution note:</span> {advice.primarySession.coaching}</div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-white/45">Suggested training structure</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {advice.weeklyStructure.map((day, idx) => (
                <div key={idx} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/78">{day}</div>
              ))}
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={onDownloadPdf}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/[0.05]"
            >
              Download PDF report
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function runSelfChecks() {
  const tests = [
    { name: "parse plain seconds", pass: parseTimeToSeconds("11.50") === 11.5 },
    { name: "parse minute format", pass: parseTimeToSeconds("1:58.40") === 118.4 },
    { name: "format seconds", pass: formatSeconds(11.5) === "11.50" },
    { name: "format minutes", pass: formatSeconds(118.4) === "1:58.40" },
    {
      name: "interpolation works",
      pass: Math.abs(localPowerInterpolate(300, { meters: 200, time: 22.8 }, { meters: 400, time: 50.6 }) - 34.8162051625) < 0.1,
    },
    {
      name: "prediction exists",
      pass: (() => {
        const res = buildPrediction("400", "sprinter", { 100: "11.5", 200: "22.8", 800: "1:58.4", age: "20", training: "5" });
        return !!res && typeof res.currentTime === "number";
      })(),
    },
    {
      name: "equivalents builder returns array",
      pass: Array.isArray(buildEquivalentPerformances("400", "sprinter", { 100: "11.5", 200: "22.8", 800: "1:58.4", age: "20", training: "5" })),
    },
    {
      name: "short-distance equivalents use event-specific predictions",
      pass: (() => {
        const rows = buildEquivalentPerformances("800", "middle", { 400: "52.0", 1500: "4:05.0", 3000: "8:55.0", age: "22", training: "6" });
        const four = rows.find((r) => r.id === "400");
        return !!four && four.time < 60;
      })(),
    },
    {
      name: "short-distance equivalent tuning lowers 600m for middle profile",
      pass: (() => {
        const raw = buildPrediction("600", "middle", { 400: "52.0", 800: "1:56.0", 1500: "4:05.0", age: "22", training: "6" });
        const tuned = buildEquivalentPerformances("800", "middle", { 400: "52.0", 800: "1:56.0", 1500: "4:05.0", age: "22", training: "6" }).find((r) => r.id === "600");
        return !!raw && !!tuned && tuned.time < raw.currentTime;
      })(),
    },
    {
      name: "best event ranking returns array",
      pass: Array.isArray(buildBestEventRanking("middle", { 400: "51.0", 800: "1:55.0", 1500: "4:02.0", age: "20", training: "5" })),
    },
  ];

  if (typeof console !== "undefined") {
    const failures = tests.filter((t) => !t.pass);
    if (failures.length) {
      console.warn("RacePotential self-checks failed:", failures.map((f) => f.name));
    }
  }
}

runSelfChecks();

export default function App() {
  const { scrollYProgress } = useScroll();
  const smoothScroll = useSpring(scrollYProgress, { stiffness: 55, damping: 24, mass: 0.55 });
  const glowY = useTransform(smoothScroll, [0, 1], ["-8%", "82%"]);
  const glowOpacity = useTransform(smoothScroll, [0, 0.2, 0.5, 0.8, 1], [0.28, 0.22, 0.18, 0.14, 0.1]);

  const [profile, setProfile] = useState(null);
  const [targetId, setTargetId] = useState("400");
  const [isPaid, setIsPaid] = useState(false);
  const [showExtraDistances, setShowExtraDistances] = useState(false);
  const [selectedExtraDistanceIds, setSelectedExtraDistanceIds] = useState([]);
  const [form, setForm] = useState({
    sex: "male",
    age: "",
    training: "",
    100: "",
    200: "",
    300: "",
    400: "",
    600: "",
    800: "",
    1000: "",
    1500: "",
    mile: "",
    2000: "",
    3000: "",
    "2mile": "",
    5000: "",
    10000: "",
    half: "",
    marathon: "",
  });

  const currentProfileConfig = profile ? PROFILE_CONFIG[profile] : null;
  const profileInputIds = currentProfileConfig ? currentProfileConfig.inputs.filter((id) => id !== targetId) : [];
  const filteredExtraIds = selectedExtraDistanceIds.filter((id) => id !== targetId && !profileInputIds.includes(id));
  const visibleInputs = [...profileInputIds, ...filteredExtraIds].map((id) => getDistanceById(id)).filter(Boolean);

  const result = useMemo(() => {
    if (!profile) return null;
    return buildPrediction(targetId, profile, form);
  }, [profile, targetId, form]);

  const equivalents = useMemo(() => {
    if (!profile) return [];
    return buildEquivalentPerformances(targetId, profile, form).slice(0, 6);
  }, [profile, targetId, form]);

  const bestEventRanking = useMemo(() => {
    if (!profile) return [];
    return buildBestEventRanking(profile, form);
  }, [profile, form]);

  const processState = getProcessState({ targetId, form, visibleInputs, result });

  const processSteps = [
    {
      key: "step1",
      label: "STEP 1",
      title: "Choose target event",
      text: "Pick the distance you want predicted",
      meta: getDistanceById(targetId)?.label || "Not selected",
    },
    {
      key: "step2",
      label: "STEP 2",
      title: "Add basic details",
      text: "Add a few athlete details for context",
      meta: String(form.age || "").trim() && String(form.training || "").trim() ? "Details added" : "Age + training still missing",
    },
    {
      key: "step3",
      label: "STEP 3",
      title: "Add race times",
      text: "Enter other performances you already have",
      meta: processState.filledPerformanceCount > 0 ? `${processState.filledPerformanceCount} time${processState.filledPerformanceCount === 1 ? "" : "s"} added` : "No performances added yet",
    },
    {
      key: "step4",
      label: "STEP 4",
      title: "See your result",
      text: "Get a realistic prediction and feedback",
      meta: result ? `${result.target.label} ready` : "Waiting for enough input",
    },
  ];

  const metricCards = result
    ? [
        { label: `Predicted ${result.target.label} now`, value: formatSeconds(result.currentTime), icon: Gauge },
        { label: `True ${result.target.label} potential`, value: formatSeconds(result.potentialTime), icon: Zap },
        { label: "Realistic range", value: `${formatSeconds(result.low)}–${formatSeconds(result.high)}`, icon: BarChart3 },
      ]
    : [];

  const availableTargets = profile
    ? DISTANCES.filter((d) => {
        if (profile === "sprinter") return d.meters <= 800;
        if (profile === "middle") return d.meters >= 400 && d.meters <= 3000;
        return d.meters >= 1500;
      })
    : [];

  const extraDistanceOptions = profile ? DISTANCES.filter((d) => !currentProfileConfig.inputs.includes(d.id) && d.id !== targetId) : [];

  const toggleExtraDistance = (id) => {
    setSelectedExtraDistanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleDownloadPdf = () => {
    if (!result) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const left = 44;
    const right = doc.internal.pageSize.getWidth() - 44;
    let y = 52;
    const fullReportLines = buildPdfReportLines(result, equivalents, profile, form);

    const ensurePage = (next = 24) => {
      if (y + next > 760) {
        doc.addPage();
        y = 52;
      }
    };

    const writeParagraph = (text, size = 11, color = [35, 35, 35], gap = 16) => {
      ensurePage(size + gap + 30);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
      const lines = doc.splitTextToSize(String(text), right - left);
      doc.text(lines, left, y);
      y += lines.length * (size + 4) + gap;
    };

    const writeSection = (text) => {
      ensurePage(40);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(220, 38, 38);
      doc.text(String(text).toUpperCase(), left, y);
      y += 18;
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.setTextColor(18, 18, 18);
    doc.text("RacePotential Report", left, y);
    y += 20;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 110);
    doc.text("Personalized race potential report", left, y);
    y += 24;
    doc.setDrawColor(230, 230, 230);
    doc.line(left, y, right, y);
    y += 24;

    writeSection("Core results");
    writeParagraph("Selected profile: " + (profile ? PROFILE_CONFIG[profile].label : "Runner"), 11, [40, 40, 40], 8);
    writeParagraph("Target event: " + result.target.label, 11, [40, 40, 40], 8);
    writeParagraph("Predicted current level: " + formatSeconds(result.currentTime), 11, [40, 40, 40], 8);
    writeParagraph("True potential: " + formatSeconds(result.potentialTime), 11, [40, 40, 40], 8);
    writeParagraph("Realistic range: " + formatSeconds(result.low) + " – " + formatSeconds(result.high), 11, [40, 40, 40], 8);
    writeParagraph("Confidence: " + result.confidence, 11, [40, 40, 40], 8);
    writeParagraph("Athlete type: " + result.athleteType, 11, [40, 40, 40], 16);

    writeSection("Equivalent performances");
    if (equivalents.length) {
      equivalents.forEach((row) => writeParagraph(row.label + ": " + formatSeconds(row.time), 11, [35, 35, 35], 4));
      y += 10;
    } else {
      writeParagraph("Not enough data yet to build strong equivalent performances.", 11, [80, 80, 80], 10);
    }

    writeSection("Detailed report");
    fullReportLines.forEach((line) => {
      if (String(line).trim() === "") {
        y += 8;
      } else {
        writeParagraph(line, 11, [35, 35, 35], 6);
      }
    });

    ensurePage(40);
    doc.setDrawColor(230, 230, 230);
    doc.line(left, 785, right, 785);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(220, 38, 38);
    doc.text("RacePotential", left, 804);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110, 110, 110);
    doc.text("Predict your next breakthrough", right, 804, { align: "right" });

    const safeProfile = (profile ? PROFILE_CONFIG[profile].label : "runner").split(" ").join("-").toLowerCase();
    const safeTarget = String(result.target.label).split(" ").join("-").toLowerCase();
    doc.save("racepotential-" + safeProfile + "-" + safeTarget + "-report.pdf");
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-neutral-950 text-white">
      <motion.div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[55vh]" style={{ y: glowY, opacity: glowOpacity }}>
        <div className="mx-auto h-full max-w-7xl px-6 lg:px-10">
          <div className="h-full w-full rounded-full bg-[radial-gradient(circle_at_center,rgba(239,68,68,0.18),rgba(239,68,68,0.08)_24%,rgba(239,68,68,0.02)_45%,transparent_68%)] blur-3xl" />
        </div>
      </motion.div>
      <div className="pointer-events-none fixed inset-0 z-0 bg-[linear-gradient(to_bottom,rgba(10,10,10,0)_0%,rgba(10,10,10,0.10)_35%,rgba(10,10,10,0.22)_100%)]" />

      <div className="relative z-10">
        {!profile && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm">
            <div className="w-full max-w-5xl rounded-[32px] border border-white/10 bg-neutral-950 p-6 shadow-2xl sm:p-8">
              <div className="mb-6 flex justify-center"><RacePotentialLogo size={52} /></div>
              <div className="inline-flex items-center gap-2 rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-sm text-red-200">
                <Activity className="h-4 w-4" /> Choose your athlete profile
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">RacePotential is now a multi-distance app</h1>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-white/75">Choose the athlete profile that best matches you. This changes the distances shown and how the prediction engine weighs your performances.</p>
              <div className="mt-8 grid gap-4 md:grid-cols-3">
                {Object.entries(PROFILE_CONFIG).map(([key, config]) => (
                  <button
                    key={key}
                    onClick={() => {
                      setProfile(key);
                      setTargetId(config.defaultTarget);
                      setSelectedExtraDistanceIds([]);
                      setShowExtraDistances(false);
                      setIsPaid(false);
                    }}
                    className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-left transition hover:border-red-400/30 hover:bg-red-500/10"
                  >
                    <div className="text-sm uppercase tracking-[0.18em] text-white/45">Profile</div>
                    <div className="mt-2 text-2xl font-semibold">{config.label}</div>
                    <p className="mt-3 leading-7 text-white/70">{config.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <section className="relative overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(239,68,68,0.20),transparent_35%),radial-gradient(circle_at_85%_20%,rgba(255,255,255,0.08),transparent_18%)]">
          <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:42px_42px]" />
          <div className="relative mx-auto grid max-w-7xl gap-10 px-6 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:px-10 lg:py-20">
            <div>
              <div className="mb-5"><RacePotentialLogo size={48} /></div>
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-5 inline-flex items-center gap-2 rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-sm text-red-200">
                <Activity className="h-4 w-4" /> Multi-distance race potential calculator
              </motion.div>
              <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                One app for <span className="text-red-400">100m to marathon</span>
              </motion.h1>
              <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-5 max-w-2xl text-lg leading-8 text-white/75">
                Estimate what you can realistically run across sprint, middle-distance, and endurance events using your existing performances and a profile-specific prediction model.
              </motion.p>

              {profile && (
                <div className="mt-8 rounded-[28px] border border-white/10 bg-white/[0.04] p-5">
                  <div className="text-xs uppercase tracking-[0.22em] text-white/45">Selected profile</div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {Object.entries(PROFILE_CONFIG).map(([key, config]) => {
                      const active = key === profile;
                      return (
                        <button
                          key={key}
                          onClick={() => {
                            setProfile(key);
                            setTargetId(config.defaultTarget);
                            setSelectedExtraDistanceIds([]);
                            setShowExtraDistances(false);
                            setIsPaid(false);
                          }}
                          className={`rounded-2xl border px-4 py-3 text-sm font-medium transition ${active ? "border-red-400/25 bg-red-500/12 text-white shadow-lg shadow-red-500/10" : "border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.06]"}`}
                        >
                          {active ? `${config.label} ✓` : config.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-white/55">Did you mean to use another runner profile? Switching profile changes the distances shown and how the model interprets your performances.</p>
                </div>
              )}

              <div className="mt-8 flex flex-wrap gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/70"><Zap className="h-4 w-4 text-red-300" /> AI-backed race potential engine</div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/70"><BarChart3 className="h-4 w-4 text-red-300" /> Built for 16 distances</div>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                
                
              </div>
            </div>

            <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="relative rounded-[32px] border border-white/10 bg-white/[0.05] p-5 pt-16 shadow-2xl backdrop-blur before:absolute before:inset-x-8 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-red-300/40 before:to-transparent sm:pt-14">
              <div className="mb-5 rounded-[28px] border border-white/10 bg-black/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs uppercase tracking-[0.22em] text-white/45">Process</div>
                  <div className="text-xs uppercase tracking-[0.18em] text-white/35">Complete the steps below</div>
                </div>
                <p className="mt-3 text-sm text-white/55">Follow the steps in order to generate your prediction.</p>

                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  {processSteps.map((step, index) => {
                    const state = processState[step.key];
                    const isDone = state === "done";
                    const isCurrent = state === "current";
                    return (
                      <div key={step.key} className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-center gap-2">
                          <div
                            className={`h-2.5 w-2.5 rounded-full ${
                              isDone ? "bg-red-400" : isCurrent ? "bg-white" : "bg-white/25"
                            }`}
                          />
                          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">{step.label}</div>
                        </div>
                        <div className={`mt-3 text-base font-semibold ${isCurrent || isDone ? "text-white" : "text-white/60"}`}>{step.title}</div>
                        <div className="mt-1 text-sm text-white/45">{step.meta}</div>

                        {index < processSteps.length - 1 && (
                          <div className="pointer-events-none absolute -right-2 top-5 hidden h-px w-4 bg-white/10 md:block" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="absolute right-5 top-5 hidden rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs uppercase tracking-[0.2em] text-white/45 sm:block">RacePotential</div>
                <div>
                  <div className="text-sm uppercase tracking-[0.2em] text-white/45">Input</div>
                  <div className="mt-1 text-xl font-semibold">Athlete profile</div>
                </div>
                <TimerReset className="h-5 w-5 text-white/50" />
              </div>

              <StepSectionHeader step="STEP 1" title="Choose your target event" description="">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    <div className="mb-2 text-sm text-white/60">Target event</div>
                    <select
                      value={targetId}
                      onChange={(e) => {
                        const nextTarget = e.target.value;
                        setTargetId(nextTarget);
                        setSelectedExtraDistanceIds((prev) => prev.filter((id) => id !== nextTarget));
                        setIsPaid(false);
                      }}
                      className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none"
                    >
                      {availableTargets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                    </select>
                  </label>
                  <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                    <div className="text-sm text-white/50">Selected target</div>
                    <div className="mt-1 text-2xl font-semibold text-white">{getDistanceById(targetId)?.label || "400m"}</div>
                    <div className="mt-2 text-sm text-white/60">The input list below automatically hides this event.</div>
                  </div>
                </div>
              </StepSectionHeader>

              <div className="mt-4">
                <StepSectionHeader step="STEP 2" title="Basic athlete details" description="">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label>
                      <div className="mb-2 text-sm text-white/60">Sex category</div>
                      <select value={form.sex} onChange={(e) => setForm((f) => ({ ...f, sex: e.target.value }))} className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none">
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="open">Open</option>
                      </select>
                    </label>
                    <label>
                      <div className="mb-2 text-sm text-white/60">Age</div>
                      <input value={form.age} placeholder="e.g. 21" onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))} className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none" />
                    </label>
                  </div>
                  <div className="mt-4">
                    <label>
                      <div className="mb-2 text-sm text-white/60">Sessions / week</div>
                      <input value={form.training} placeholder="e.g. 6" onChange={(e) => setForm((f) => ({ ...f, training: e.target.value }))} className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none" />
                    </label>
                  </div>
                </StepSectionHeader>
              </div>

              <div className="mt-4">
                <StepSectionHeader step="STEP 3" title="Enter your other performances" description="">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {visibleInputs.map((d) => (
                      <label key={d.id} className="block">
                        <div className="mb-2 text-sm text-white/60">{d.label}</div>
                        <input
                          value={form[d.id]}
                          placeholder={
                            d.id === "100" ? "e.g. 10.85" :
                            d.id === "200" ? "e.g. 21.90" :
                            d.id === "300" ? "e.g. 34.80" :
                            d.id === "400" ? "e.g. 49.50" :
                            d.id === "600" ? "e.g. 1:20.50" :
                            d.id === "800" ? "e.g. 1:52.40" :
                            d.id === "1000" ? "e.g. 2:24.00" :
                            d.id === "1500" ? "e.g. 3:45.20" :
                            d.id === "mile" ? "e.g. 4:03.50" :
                            d.id === "2000" ? "e.g. 5:08.00" :
                            d.id === "3000" ? "e.g. 8:05.00" :
                            d.id === "2mile" ? "e.g. 8:42.00" :
                            d.id === "5000" ? "e.g. 14:35.00" :
                            d.id === "10000" ? "e.g. 30:20.00" :
                            d.id === "half" ? "e.g. 1:08:30" :
                            d.id === "marathon" ? "e.g. 2:24:00" :
                            "e.g. 49.50"
                          }
                          onChange={(e) => {
                            setForm((f) => ({ ...f, [d.id]: e.target.value }));
                            setIsPaid(false);
                          }}
                          className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none placeholder:text-white/25"
                        />
                      </label>
                    ))}
                  </div>

                  <div className="mt-5 border-t border-white/10 pt-5">
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-white/40">Optional addition to STEP 3</div>
                    <button type="button" onClick={() => setShowExtraDistances((prev) => !prev)} className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white/85 transition hover:bg-white/[0.07]">
                      <Plus className="h-4 w-4 text-red-300" />
                      Add more distances for a better estimate
                      <ChevronDown className={`h-4 w-4 transition ${showExtraDistances ? "rotate-180" : ""}`} />
                    </button>
                    <p className="mt-2 text-xs leading-6 text-white/50">Add any extra race times you have. More relevant data usually gives the model a stronger estimate.</p>

                    {showExtraDistances && (
                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                        <div className="text-sm font-medium text-white">Additional distances</div>
                        <div className="mt-1 text-xs leading-6 text-white/50">Select any additional events you want to include to help the prediction.</div>
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                          {extraDistanceOptions.map((d) => {
                            const checked = filteredExtraIds.includes(d.id);
                            return (
                              <label key={d.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm text-white/80">
                                <input type="checkbox" checked={checked} onChange={() => toggleExtraDistance(d.id)} className="h-4 w-4" />
                                <span>{d.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </StepSectionHeader>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
          <div className="grid gap-4 md:grid-cols-3">
            {metricCards.map((card) => {
              const Icon = card.icon;
              return (
                <motion.div key={card.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-[30px] border border-white/10 bg-gradient-to-br from-white/[0.05] to-white/[0.025] p-5 shadow-lg shadow-black/10">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-white/55">{card.label}</div>
                    <Icon className="h-5 w-5 text-red-300" />
                  </div>
                  <div className="mt-4 text-3xl font-semibold tracking-tight">{card.value}</div>
                  <div className="mt-2 h-px w-full bg-gradient-to-r from-red-300/30 via-white/10 to-transparent" />
                </motion.div>
              );
            })}
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-6 px-6 pb-16 lg:grid-cols-[1.05fr_0.95fr] lg:px-10">
          <div>
            <StepSectionHeader
              step="STEP 4"
              title="Your predicted performance"
              description=""
              className="p-6"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-2xl font-semibold">Personal result breakdown</h2>
                {result ? (
                  <div className="inline-flex items-center gap-2 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-xs uppercase tracking-[0.18em] text-red-100">
                    <Sparkles className="h-3.5 w-3.5" /> {result.target.label} ready
                  </div>
                ) : null}
              </div>

              {!result && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ duration: 0.45 }}
                  className="mt-4 rounded-2xl border border-dashed border-white/20 bg-black/20 p-8 text-center"
                >
                  <div className="text-sm uppercase tracking-[0.18em] text-white/40">Awaiting your inputs</div>
                  <div className="mt-3 text-3xl font-semibold text-white/75">Your result will appear here</div>
                  <p className="mt-3 text-sm leading-6 text-white/50">
                    Complete STEP 1–3 above, then scroll back here for your predicted performance, event fit, and premium report preview.
                  </p>
                </motion.div>
              )}

              {result && (
                <motion.div
                  initial={{ opacity: 0, y: 28 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.15 }}
                  transition={{ duration: 0.55, ease: "easeOut" }}
                >
                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-3 rounded-[28px] border border-white/10 bg-gradient-to-r from-red-500/10 via-white/[0.03] to-transparent p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-white/45">Result summary</div>
                        <div className="mt-2 text-3xl font-semibold tracking-tight">{result.target.label} potential: {formatSeconds(result.potentialTime)}</div>
                        <div className="mt-2 text-sm leading-6 text-white/65">Estimated only from your other performances, not from a time entered for the target itself.</div>
                      </div>
                      <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-right">
                        <div className="text-xs uppercase tracking-[0.2em] text-red-100/80">Headroom</div>
                        <div className="mt-1 text-2xl font-semibold text-white">{result.untapped.toFixed(2)} s</div>
                      </div>
                    </div>
                  </div>

                  {[["Speed", result.speedScore], ["Endurance", result.enduranceScore], ["Speed endurance", result.speedEnduranceScore]].map(([label, score]) => (
                    <div key={label} className="rounded-[26px] border border-white/10 bg-black/20 p-4 shadow-inner shadow-black/20">
                      <div className="text-sm text-white/55">{label}</div>
                      <div className="mt-2 text-2xl font-semibold">{score}/100</div>
                      <div className="mt-3 h-2 rounded-full bg-white/10"><div className="h-2 rounded-full bg-red-400" style={{ width: `${score}%` }} /></div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-[26px] border border-white/10 bg-black/20 p-4 shadow-inner shadow-black/20">
                    <div className="flex items-center gap-2 text-sm text-white/55"><Flame className="h-4 w-4" /> Athlete type</div>
                    <div className="mt-2 text-2xl font-semibold">{result.athleteType}</div>
                    <p className="mt-3 text-sm leading-6 text-white/65">{result.athleteTypeSummary}</p>
                  </div>
                  <div className="rounded-[26px] border border-white/10 bg-black/20 p-4 shadow-inner shadow-black/20">
                    <div className="flex items-center gap-2 text-sm text-white/55"><TrendingDown className="h-4 w-4" /> Untapped potential</div>
                    <div className="mt-2 text-2xl font-semibold">{result.untapped.toFixed(2)} s</div>
                    <p className="mt-3 text-sm leading-6 text-white/65">This is a bounded upside estimate, not a fantasy number. The goal is realistic headroom, not fake certainty.</p>
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><Sparkles className="h-4 w-4" /> Short personal feedback</div>
                  <div className="mt-3 rounded-2xl border border-red-400/15 bg-red-500/10 p-4">
                    <div className="text-sm font-medium text-white">{result.shortFeedback.headline}</div>
                    <div className="mt-2 text-sm leading-6 text-white/70">{result.shortFeedback.summary}</div>
                    <p className="mt-3 text-sm leading-7 text-white/85">{result.shortFeedback.body}</p>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><CheckCircle2 className="h-4 w-4" /> What you seem good at</div>
                  <ul className="mt-3 space-y-2 text-white/85">{result.strengths.map((item) => <li key={item}>• {item}</li>)}</ul>
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><TrendingDown className="h-4 w-4" /> What you should train more</div>
                  <ul className="mt-3 space-y-2 text-white/85">{result.needs.map((item) => <li key={item}>• {item}</li>)}</ul>
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><Medal className="h-4 w-4" /> Best event fit</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {bestEventRanking.map((row, index) => (
                      <div key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                        <div className="text-xs uppercase tracking-[0.2em] text-white/45">#{index + 1}</div>
                        <div className="mt-2 text-lg font-semibold text-white/90">{row.label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><MapPin className="h-4 w-4" /> Equivalent performances</div>
                  {!isPaid ? (
                    <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-2 text-sm text-white/70"><Lock className="h-4 w-4" /> Premium only</div>
                      <p className="mt-3 text-sm leading-6 text-white/60">
                        Unlock to see your equivalent performances across nearby events. This is especially useful for comparing how your profile translates from 100m to 1000m and beyond.
                      </p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/45 blur-[2px]">400m — 49.8x</div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/45 blur-[2px]">800m — 1:53.xx</div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {equivalents.map((row) => (
                        <div key={row.id} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                          <div>
                            <div className="text-white/75">{row.label}</div>
                            <div className="mt-1 text-xs text-white/45">{row.confidence} confidence</div>
                          </div>
                          <div className="font-semibold text-white">{formatSeconds(row.time)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <div className="flex items-center gap-2 text-sm text-white/60"><MapPin className="h-4 w-4" /> Main models used</div>
                  <ul className="mt-3 space-y-2 text-white/80">{result.methods.slice(0, 4).map((m) => <li key={m}>• {m}</li>)}</ul>
                </div>

                                <PremiumReportSection result={result} equivalents={equivalents} profile={profile} form={form} isPaid={isPaid} onUnlock={() => setIsPaid(true)} onDownloadPdf={handleDownloadPdf} />
                </motion.div>
              )}
            </StepSectionHeader>
          </div>

          <div className="space-y-6">
            <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-gradient-to-br from-red-500/20 to-white/5 p-6 shadow-xl shadow-red-500/10 before:absolute before:-right-16 before:-top-16 before:h-40 before:w-40 before:rounded-full before:bg-red-400/10 before:blur-3xl">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.18em] text-white/55"><Share2 className="h-4 w-4" /> Share card preview</div>
              <div className="mt-5 overflow-hidden rounded-[30px] border border-white/10 bg-neutral-950 p-6 shadow-2xl ring-1 ring-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-red-200"><Share2 className="h-3.5 w-3.5" /> Share result</div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-white/45"><Activity className="h-3.5 w-3.5" /> RacePotential.app</div>
                </div>
                <div className="mt-6 flex items-center gap-3"><RacePotentialLogo size={34} /></div>
                <div className="mt-5 text-sm uppercase tracking-[0.22em] text-red-300">True {result?.target.label || "Race"} Potential</div>
                <div className="mt-4 text-5xl font-semibold tracking-tight">{result ? formatSeconds(result.potentialTime) : "49.15"}</div>
                <div className="mt-3 max-w-md text-white/70">Built from your {profile ? PROFILE_CONFIG[profile].label.toLowerCase() : "athlete"} profile and your selected event range</div>
                <div className="mt-6 flex flex-wrap gap-2">
                  <div className="inline-flex rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-sm text-red-100">± {result ? result.uncertainty : "0.50"} realistic uncertainty</div>
                  <div className="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75">Confidence: {result?.confidence || "Moderate"}</div>
                </div>
                <div className="mt-8 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-white/45">Athlete type</div>
                    <div className="mt-2 text-lg font-semibold text-white/90">{result ? result.athleteType : "Athlete profile"}</div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-white/45">Target</div>
                    <div className="mt-2 text-lg font-semibold text-white/90">{result?.target.label || "400m"}</div>
                  </div>
                </div>
                <div className="mt-6 rounded-2xl border border-white/10 bg-gradient-to-r from-red-500/10 via-white/[0.03] to-transparent p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-white/45">Brand</div>
                  <div className="mt-2 text-base font-medium text-white">RacePotential</div>
                  <div className="mt-1 text-sm leading-6 text-white/60">Multi-distance race potential calculator for runners from 100m to marathon.</div>
                </div>
                <div className="mt-8 flex items-center justify-between gap-4 border-t border-white/10 pt-4 text-sm text-white/40">
                  <div>racepotential.app</div>
                  <div>Predict your next breakthrough</div>
                </div>
              </div>
            </div>

            <div className="rounded-[32px] border border-white/10 bg-white/[0.04] p-6 shadow-xl shadow-black/10">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.18em] text-white/45"><Info className="h-4 w-4" /> Why it works</div>
              <h3 className="mt-2 text-xl font-semibold">Built to feel clear first, detailed second</h3>
              <ul className="mt-4 space-y-3 text-white/70">
                <li>• STEP 1 chooses the target event you want predicted.</li>
                <li>• STEP 2 adds a bit of athlete context.</li>
                <li>• STEP 3 adds your supporting performances.</li>
                <li>• STEP 4 gives you a free prediction, short feedback, best-event fit, and equivalent performances.</li>
                <li>• The $0.99 unlock gives the full AI feedback and a downloadable PDF report.</li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
