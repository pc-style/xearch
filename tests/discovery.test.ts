import { describe, expect, it } from "vitest";
import {
  interactionsOf,
  normalizeHandle,
  postsInCapture,
  rankInteractions,
  type DiscoveryPost,
} from "../scripts/lib/discovery.mjs";

// Shapes copied from real x.md posts in the retained captures: `replying_to`
// is a list of {screen_name}, `quote.author.screen_name`, mention facets in
// `raw_text.facets`, and `reposted_by` for a repost seen on a timeline.
function post(author: string, extra: Partial<DiscoveryPost> = {}): DiscoveryPost {
  return { author: { screen_name: author }, raw_text: { facets: [] }, ...extra };
}

const reply = (author: string, to: string) => post(author, { replying_to: [{ screen_name: to }] });

const quote = (author: string, of: string) =>
  post(author, { quote: { author: { screen_name: of } } });

const mention = (author: string, who: string) =>
  post(author, { raw_text: { facets: [{ type: "mention", original: who }] } });

describe("discovery ranking", () => {
  it("counts replies, quotes, mentions and reposts from indexed accounts only", () => {
    const posts = [
      reply("theo", "ballingt"),
      quote("theo", "ballingt"),
      mention("notpronsh", "BallingT"),
      post("ballingt", { reposted_by: [{ screen_name: "theo" }] }),
      reply("stranger", "ballingt"), // not indexed: ignored
      reply("theo", "notpronsh"), // already indexed: ignored
      reply("theo", "theo"), // self: ignored
    ];

    const ranked = rankInteractions(posts, {
      indexed: ["theo", "notpronsh"],
      exclude: [],
      minInteractions: 1,
    });

    expect(ranked).toEqual([
      {
        handle: "ballingt",
        interactions: 4,
        discoveredFrom: [
          { handle: "theo", interactions: 3 },
          { handle: "notpronsh", interactions: 1 },
        ],
      },
    ]);
  });

  it("applies the threshold and skips accounts that already have an import", () => {
    const posts = [reply("theo", "alpha"), reply("theo", "alpha"), reply("theo", "beta")];
    expect(
      rankInteractions(posts, { indexed: ["theo"], exclude: [], minInteractions: 2 }).map(
        (r) => r.handle,
      ),
    ).toEqual(["alpha"]);
    expect(
      rankInteractions(posts, { indexed: ["theo"], exclude: ["Alpha"], minInteractions: 1 }).map(
        (r) => r.handle,
      ),
    ).toEqual(["beta"]);
  });

  it("only accepts real handles", () => {
    expect(normalizeHandle("@Theo ")).toBe("theo");
    expect(normalizeHandle("not a handle")).toBeNull();
    expect(normalizeHandle(42)).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
    expect([...interactionsOf(mention("a", "way-too-long-for-a-handle"))]).toEqual([]);
  });

  it("reads posts out of capture files in either record shape", () => {
    const capture = {
      records: [
        { payload: { posts: [post("a"), post("b")] } },
        { payload: { post: post("c") } },
        { payload: { profile: {} } },
      ],
    };

    expect(postsInCapture(capture).map((p) => p.author?.screen_name)).toEqual(["a", "b", "c"]);
    expect(postsInCapture({})).toEqual([]);
  });
});
