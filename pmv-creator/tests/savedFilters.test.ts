import { describe, expect, it } from "vitest";
import { convertSavedFilter } from "../src/stash/savedFilters";

describe("Stash saved filters -> SceneFilterType", () => {
  it("turns the criteria of the interface into GraphQL criteria", () => {
    // as Stash 0.31's scene list saves them (object_filter)
    const { filter, skipped } = convertSavedFilter({
      tags: { modifier: "INCLUDES_ALL", value: { items: [{ id: "4", label: "Blonde" }], excluded: [{ id: "9", label: "Solo" }], depth: -1 } },
      performers: { modifier: "INCLUDES", value: { items: [{ id: "12", label: "Mia" }, { id: "13", label: "Ann" }], excluded: [] } },
      studios: { modifier: "IS_NULL", value: { items: [], excluded: [], depth: 0 } },
      rating100: { modifier: "GREATER_THAN", value: { value: 60, value2: null } },
      duration: { modifier: "BETWEEN", value: { value: 60, value2: 600 } },
      date: { modifier: "GREATER_THAN", value: { value: "2023-01-01" } },
      resolution: { modifier: "EQUALS", value: "1080p" },
      orientation: { value: ["Portrait"] },
      organized: { modifier: "EQUALS", value: "true" },
      has_markers: { modifier: "EQUALS", value: "true" },
      is_missing: { modifier: "EQUALS", value: "studio" },
      path: { modifier: "INCLUDES", value: "/clips/" },
      phash_distance: { modifier: "EQUALS", value: { value: "abcd", distance: 4 } },
      stash_id_endpoint: { modifier: "NOT_NULL", value: { endpoint: "x", stashID: "" } },
      custom_fields: { value: [{ field: "a", value: [1] }] },
    });
    expect(filter).toEqual({
      tags: { value: ["4"], excludes: ["9"], depth: -1, modifier: "INCLUDES_ALL" },
      performers: { value: ["12", "13"], modifier: "INCLUDES" },
      studios: { modifier: "IS_NULL", depth: 0 },
      rating100: { value: 60, modifier: "GREATER_THAN" },
      duration: { value: 60, value2: 600, modifier: "BETWEEN" },
      date: { value: "2023-01-01", modifier: "GREATER_THAN" },
      resolution: { value: "FULL_HD", modifier: "EQUALS" },
      orientation: { value: ["PORTRAIT"] },
      organized: true,
      has_markers: "true",
      is_missing: "studio",
      path: { value: "/clips/", modifier: "INCLUDES" },
      phash_distance: { value: "abcd", distance: 4, modifier: "EQUALS" },
      stash_id_endpoint: { endpoint: "x", modifier: "NOT_NULL" },
    });
    expect(skipped).toEqual(["custom_fields"]);
  });

  it("asks duplicates with Stash's flags and empty numbers with an Int", () => {
    // as classic Stash 0.31 saves "PHash: True, Title: False"; an old filter saved "true"
    expect(convertSavedFilter({ duplicated: { modifier: "EQUALS", value: { phash: true, title: false } } }).filter).toEqual({ duplicated: { phash: true, title: false } });
    expect(
      convertSavedFilter({
        duplicated: { modifier: "EQUALS", value: "true" },
        rating100: { modifier: "IS_NULL", value: {} },
        o_counter: { modifier: "NOT_NULL" },
        date: { modifier: "IS_NULL", value: {} },
        title: { modifier: "IS_NULL", value: "" },
      }).filter,
    ).toEqual({
      duplicated: { phash: true },
      rating100: { modifier: "IS_NULL", value: 0 },
      o_counter: { modifier: "NOT_NULL", value: 0 },
      date: { modifier: "IS_NULL", value: "" },
      title: { modifier: "IS_NULL", value: "" },
    });
  });

  it("names what it can't turn instead of guessing", () => {
    expect(convertSavedFilter({ resolution: { modifier: "EQUALS", value: "potato" }, rating100: { value: { value: "x" } }, odd: 3 })).toEqual({
      filter: {},
      skipped: ["resolution", "rating100", "odd"],
    });
    expect(convertSavedFilter(null)).toEqual({ filter: {}, skipped: [] });
  });
});
