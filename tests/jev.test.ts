import { describe, expect, it } from "vitest";
import {
  decodeSystemOne,
  intentRequest,
  INTENTS,
  pickRequest,
  postId,
  postLine,
  readIntent,
  readPick,
  readScore,
  scoreRequest,
  type JevPost,
} from "../convex/lib/jev";

const NOW = Date.UTC(2026, 9, 2);

const DAY = 86_400_000;

const post = (overrides: Partial<JevPost> = {}): JevPost => ({
  tweetId: "1",
  author: "theo",
  text: "Local-first   apps\nare back",
  likes: 1_200,
  createdAt: NOW - 3 * DAY,
  links: ["https://www.github.com/a/b", "https://github.com/c", "not a url"],
  ...overrides,
});

describe("what Jev reads about a post", () => {
  it("turns numbers and dates into words and collapses whitespace", () => {
    expect(postLine(post(), 7, NOW)).toBe(
      "p07| @theo (popular, this week, links github.com): Local-first apps are back",
    );
  });

  it("leaves out signals the post does not have", () => {
    expect(postLine(post({ likes: undefined, createdAt: undefined, links: [] }), 0, NOW)).toBe(
      "p00| @theo: Local-first apps are back",
    );
  });

  it("caps the text Jev reads", () => {
    const line = postLine(post({ text: "x".repeat(2_000) }), 0, NOW);

    expect(line.endsWith("x".repeat(400))).toBe(true);
    expect(line).not.toContain("x".repeat(401));
  });
});

describe("requests", () => {
  const posts = [post(), post({ tweetId: "2", author: "dan" })];

  it("asks for the intent with one option per hardcoded category", () => {
    const request = intentRequest("best local first libraries");
    const question = request.questions.intent;

    expect(request.state).toBe("best local first libraries");
    expect(question.type).toBe("choice");
    expect(Object.keys(question.type === "choice" ? question.criteria : {})).toEqual(
      Object.keys(INTENTS),
    );
  });

  it("pick: one choice over every candidate id, posts in the state", () => {
    const request = pickRequest("local first", "resources", posts, NOW);
    const question = request.questions.pick;

    expect(request.state).toBe(posts.map((p, i) => postLine(p, i, NOW)).join("\n"));
    expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["p00", "p01"]);
    expect(question.instructions).toMatchObject({ wants: INTENTS.resources.wants });
  });

  it("score: one noul per candidate, each carrying only its own post", () => {
    const request = scoreRequest("local first", "news", posts, NOW);

    expect(request.state).toEqual({ search: "local first", wants: INTENTS.news.wants });
    expect(Object.keys(request.questions)).toEqual(["p00", "p01"]);
    expect(request.questions.p01.instructions).toMatchObject({ post: postLine(posts[1], 1, NOW) });
  });
});

describe("answers", () => {
  const usage = { input_tokens: 10, output_tokens: 2 };

  it("reads the intent and rejects one outside the categories", () => {
    const answer = (choice: string) =>
      decodeSystemOne({
        model: "jev-1.13.0",
        answers: {
          intent: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.8 },
        },
        usage,
      });

    expect(readIntent(answer("howto"))).toEqual({
      key: "howto",
      label: "how-to",
      confidence: 0.8,
    });
    expect(() => readIntent(answer("billing"))).toThrow();
  });

  it("reads pick probabilities in candidate order, missing ones as 0", () => {
    const response = decodeSystemOne({
      model: "jev-1.13.0",
      answers: {
        pick: {
          type: "choice",
          choice: "p01",
          probabilities: { p01: 0.9, p00: 0.1 },
          confidence: 0.7,
        },
      },
      usage,
    });

    expect(readPick(response, 3)).toEqual([0.1, 0.9, 0]);
  });

  it("reads one noul per candidate and refuses an incomplete score", () => {
    const response = decodeSystemOne({
      model: "jev-1.13.0",
      answers: {
        [postId(0)]: { type: "noul", noul: 0.2 },
        [postId(1)]: { type: "noul", noul: 0.6 },
      },
      usage,
    });

    expect(readScore(response, 2)).toEqual([0.2, 0.6]);
    expect(() => readScore(response, 3)).toThrow();
  });

  it("rejects a response that is not the documented shape", () => {
    expect(() => decodeSystemOne({ answers: {} })).toThrow();
  });
});
