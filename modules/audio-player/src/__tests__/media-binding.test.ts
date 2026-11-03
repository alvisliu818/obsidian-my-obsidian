import { describe, expect, it } from "vitest";
import {
    extractMediaReferences,
    parseTimestampLink,
    selectMediaBinding,
} from "../media-binding";
import type { MediaBinding } from "../media-binding";
import type { TFile } from "obsidian";

/** 测试用假 TFile（只用 path / name） */
function fakeFile(path: string): TFile {
    return {
        path,
        name: path.split("/").pop() ?? path,
    } as unknown as TFile;
}

function binding(id: string | null, path: string): MediaBinding {
    return { id, sourceLink: path, type: "audio", file: fakeFile(path) };
}

describe("parseTimestampLink", () => {
    it("parses mm:ss audio links", () => {
        expect(parseTimestampLink("#audio-time=00:13")).toEqual({
            seconds: 13,
            label: "00:13",
            mediaType: "audio",
            mediaId: null,
        });
    });

    it("parses h:mm:ss video links", () => {
        expect(parseTimestampLink("#video-time=1:02:03")).toEqual({
            seconds: 3723,
            label: "1:02:03",
            mediaType: "video",
            mediaId: null,
        });
    });

    it("parses milliseconds", () => {
        expect(parseTimestampLink("#audio-time=01:23.456")).toEqual({
            seconds: 83.456,
            label: "01:23.456",
            mediaType: "audio",
            mediaId: null,
        });
    });

    it("extracts the alias from &audio=", () => {
        expect(parseTimestampLink("#audio-time=00:13&audio=part1")).toEqual({
            seconds: 13,
            label: "00:13",
            mediaType: "audio",
            mediaId: "part1",
        });
    });

    it("ignores an alias of the wrong media type", () => {
        // audio-timestamp-player 固化行为：#video-time=…&audio=wrong → mediaId=null
        expect(parseTimestampLink("#video-time=00:13&audio=wrong")).toEqual({
            seconds: 13,
            label: "00:13",
            mediaType: "video",
            mediaId: null,
        });
    });

    it("handles URL encoding and &amp;", () => {
        expect(parseTimestampLink("#audio-time=00%3A13&amp;audio=part1")).toEqual({
            seconds: 13,
            label: "00:13",
            mediaType: "audio",
            mediaId: "part1",
        });
    });

    it("rejects out-of-range seconds", () => {
        expect(parseTimestampLink("#audio-time=00:99")).toBeNull();
    });

    it("rejects invalid aliases", () => {
        expect(parseTimestampLink("#audio-time=00:13&audio=-bad")).toBeNull();
    });

    it("returns null for non-time anchors", () => {
        expect(parseTimestampLink("#some-heading")).toBeNull();
        expect(parseTimestampLink("note.md#audio-time=")).toBeNull();
    });
});

describe("extractMediaReferences", () => {
    it("assigns the same-line alias to the first embed only", () => {
        const refs = extractMediaReferences(
            "![[a.mp3]] %%audio-id: part1%%\n![[b.mp3]]",
            "audio",
        );
        expect(refs).toEqual([
            { id: "part1", sourceLink: "a.mp3", type: "audio" },
            { id: null, sourceLink: "b.mp3", type: "audio" },
        ]);
    });

    it("lowercases ids and is case-insensitive", () => {
        const refs = extractMediaReferences("![[A.MP3]] %%AUDIO-ID: Part1%%", "audio");
        expect(refs[0].id).toBe("part1");
    });

    it("ignores embeds of other media types", () => {
        expect(extractMediaReferences("![[a.mp4]]", "audio")).toEqual([]);
        expect(extractMediaReferences("![[a.mp3]]", "video")).toEqual([]);
    });

    it("keeps subpath links intact", () => {
        const refs = extractMediaReferences("![[folder/part 1.mp3]]", "audio");
        expect(refs[0].sourceLink).toBe("folder/part 1.mp3");
    });
});

describe("selectMediaBinding", () => {
    it("auto-selects the only embedding when no alias is given", () => {
        const result = selectMediaBinding([binding(null, "a.mp3")], null);
        expect(result.error).toBeNull();
        expect(result.binding?.file.path).toBe("a.mp3");
    });

    it("reports ambiguous when several embeddings share no alias", () => {
        const result = selectMediaBinding(
            [binding(null, "a.mp3"), binding(null, "b.mp3")],
            null,
        );
        expect(result.error).toBe("ambiguous");
        expect(result.binding).toBeNull();
    });

    it("selects by alias, case-insensitively", () => {
        const result = selectMediaBinding(
            [binding("part1", "a.mp3"), binding("part2", "b.mp3")],
            "PART2",
        );
        expect(result.error).toBeNull();
        expect(result.binding?.file.path).toBe("b.mp3");
    });

    it("reports unknown for a missing alias", () => {
        const result = selectMediaBinding([binding("part1", "a.mp3")], "part9");
        expect(result.error).toBe("unknown");
    });

    it("reports duplicate when an alias is declared twice", () => {
        const result = selectMediaBinding(
            [binding("part1", "a.mp3"), binding("part1", "b.mp3")],
            "part1",
        );
        expect(result.error).toBe("duplicate");
    });

    it("reports none when nothing is embedded", () => {
        expect(selectMediaBinding([], null).error).toBe("none");
        expect(selectMediaBinding([], "part1").error).toBe("none");
    });
});
