import * as z from "zod/mini";
import type { Json } from "./results";

/**
 * Jev search: TypeSafe's Jev model reranks the posts the search service
 * already retrieved, in two steps.
 *
 *   1. One Choice reads the query and picks what the searcher wants
 *      (`INTENTS` below; hardcoded on purpose, so a wrong guess is visible).
 *   2. Two requests, sent in parallel, rank the candidates for that intent:
 *      - "pick": one Choice over every candidate id. Its probability map
 *        is the ranking (docs.typesafe.ai/cookbooks/semantic_find).
 *      - "score": one Noul per candidate, each carrying its own post, so a
 *        post is judged without the other 59 as distractors
 *        (docs.typesafe.ai/cookbooks/rerank_typesafe).
 *
 * Both rankings come back so /pc-jev can compare them side by side.
 * API reference: https://docs.typesafe.ai/api.md
 */

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export const JEV_MODEL = "jev-latest";

/** Three search-service pages of 20 (convex/search.ts `limit: 20`). */
export const MAX_CANDIDATES = 60;

/** Characters of a post Jev reads; enough to judge it, small enough to stay fast. */
const POST_CHARS = 400;

export const INTENTS = {
  specific_post: {
    label: "a specific post",
    describe: "Looking for one particular post they remember",
    wants: "the one post that matches what they describe most exactly",
  },
  opinions: {
    label: "opinions",
    describe: "Wants people's takes, opinions, or reactions on a topic",
    wants: "posts that state a clear opinion or take on the topic",
  },
  news: {
    label: "news",
    describe: "Wants announcements, launches, releases, or news",
    wants: "posts that announce or report something new about the topic",
  },
  howto: {
    label: "how-to",
    describe: "Wants tips, explanations, or how-to advice",
    wants: "posts that explain or teach something concrete about the topic",
  },
  resources: {
    label: "resources",
    describe: "Wants links to articles, tools, repos, papers, or videos",
    wants: "posts that share a link to a useful resource on the topic",
  },
  humor: {
    label: "humor",
    describe: "Wants jokes, memes, or funny posts",
    wants: "posts that are funny or entertaining about the topic",
  },
  general: {
    label: "general",
    describe: "A broad look at a topic, or anything else",
    wants: "posts that are relevant and substantive about the topic",
  },
} as const;

export type IntentKey = keyof typeof INTENTS;

function isIntentKey(value: string): value is IntentKey {
  return Object.hasOwn(INTENTS, value);
}

/** What Jev reads about one candidate. */
export interface JevPost {
  readonly tweetId: string;
  readonly author: string;
  readonly text: string;
  readonly likes?: number;
  readonly createdAt?: number;
  readonly links: readonly string[];
}

const DAY = 86_400_000;

// Jev reads numbers and dates as text (docs.typesafe.ai model-jaggedness
// "Math and Numbers", "Date and time comparison"), so both become words here.
function engagement(likes: number | undefined): string | null {
  if (likes === undefined) return null;

  if (likes >= 10_000) return "viral";

  if (likes >= 1_000) return "popular";

  if (likes >= 50) return "some engagement";

  return "little engagement";
}

function age(createdAt: number | undefined, now: number): string | null {
  if (createdAt === undefined) return null;
  const days = (now - createdAt) / DAY;

  if (days < 7) return "this week";

  if (days < 31) return "this month";

  if (days < 365) return "this year";

  return "over a year ago";
}

function domain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Option id for the candidate at `index`: p00, p01, ... */
export function postId(index: number): string {
  return `p${String(index).padStart(2, "0")}`;
}

/** One line per post: `p07| @theo (popular, this month, links github.com): text`. */
export function postLine(post: JevPost, index: number, now: number): string {
  const domains = [...new Set(post.links.map(domain).filter((d) => d !== null))];

  const signals = [
    engagement(post.likes),
    age(post.createdAt, now),
    domains.length ? `links ${domains.slice(0, 3).join(", ")}` : null,
  ].filter((s) => s !== null);

  const text = post.text.replace(/\s+/g, " ").trim().slice(0, POST_CHARS);
  const meta = signals.length ? ` (${signals.join(", ")})` : "";

  return `${postId(index)}| @${post.author}${meta}: ${text}`;
}

type Instructions = string | Record<string, string>;

type Question =
  | { type: "choice"; instructions: Instructions; criteria: Record<string, string | null> }
  | {
      type: "noul";
      instructions: Instructions;
      criteria?: { true: string; false: string };
    };

export interface SystemOneRequest {
  state: string | Record<string, string>;
  model: string;
  questions: Record<string, Question>;
}

export function intentRequest(query: string): SystemOneRequest {
  return {
    state: query,
    model: JEV_MODEL,
    questions: {
      intent: {
        type: "choice",
        instructions:
          "This is a search someone typed to find posts on X. What do they want to find?",
        criteria: Object.fromEntries(
          Object.entries(INTENTS).map(([key, intent]) => [key, intent.describe]),
        ),
      },
    },
  };
}

function rankQuestion(subject: string) {
  return `Which ${subject} is the best result for someone who searched \`search\` and wants \`wants\`?`;
}

export function pickRequest(
  query: string,
  intent: IntentKey,
  posts: readonly JevPost[],
  now: number,
): SystemOneRequest {
  return {
    state: posts.map((post, index) => postLine(post, index, now)).join("\n"),
    model: JEV_MODEL,
    questions: {
      pick: {
        type: "choice",
        instructions: {
          search: query,
          wants: INTENTS[intent].wants,
          question: rankQuestion("post"),
        },
        criteria: Object.fromEntries(posts.map((_, index) => [postId(index), null])),
      },
    },
  };
}

export function scoreRequest(
  query: string,
  intent: IntentKey,
  posts: readonly JevPost[],
  now: number,
): SystemOneRequest {
  return {
    state: { search: query, wants: INTENTS[intent].wants },
    model: JEV_MODEL,
    questions: Object.fromEntries(
      posts.map((post, index) => [
        postId(index),
        {
          type: "noul",
          instructions: {
            post: postLine(post, index, now),
            question: `Is \`post\` a good result for someone who searched \`search\` and wants \`wants\`?`,
          },
          criteria: {
            true: "The post is about what they searched for and gives them what they want",
            false:
              "The post is off topic, only mentions the search words in passing, or does not give them what they want",
          },
        },
      ]),
    ),
  };
}

const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const noulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });

const systemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([choiceAnswer, noulAnswer])),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export type SystemOneResponse = z.infer<typeof systemOneResponse>;

export function decodeSystemOne(body: Json): SystemOneResponse {
  return systemOneResponse.parse(body);
}

export function readIntent(response: SystemOneResponse) {
  const answer = response.answers.intent;

  if (answer?.type !== "choice" || !isIntentKey(answer.choice))
    throw new Error("TypeSafe returned no usable intent.");

  return { key: answer.choice, label: INTENTS[answer.choice].label, confidence: answer.confidence };
}

/** The pick probability for each candidate, in candidate order. */
export function readPick(response: SystemOneResponse, count: number): number[] {
  const answer = response.answers.pick;

  if (answer?.type !== "choice") throw new Error("TypeSafe returned no pick answer.");

  return Array.from({ length: count }, (_, index) => answer.probabilities[postId(index)] ?? 0);
}

/** The noul for each candidate, in candidate order. */
export function readScore(response: SystemOneResponse, count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const answer = response.answers[postId(index)];

    if (answer?.type !== "noul") throw new Error("TypeSafe returned an incomplete score.");

    return answer.noul;
  });
}
