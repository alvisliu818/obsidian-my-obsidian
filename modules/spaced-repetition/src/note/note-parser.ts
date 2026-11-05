import { TopicPath } from "../data/data-structures/deck/topic-path";
import { ISRNoteTFile } from "../data/data-structures/file/note-file";
import { SRSettings } from "../data/settings";
import { Note } from "./note";
import { NoteQuestionParser } from "./note-question-parser";
import { TextDirection } from "../utils/strings";

export class NoteParser {
    settings: SRSettings;
    noteText: string;

    constructor(settings: SRSettings) {
        this.settings = settings;
    }

    async parse(
        noteFile: ISRNoteTFile,
        defaultTextDirection: TextDirection,
        folderTopicPath: TopicPath,
    ): Promise<Note> {
        const questionParser: NoteQuestionParser = new NoteQuestionParser(this.settings);
        const questions = await questionParser.createQuestionList(
            noteFile,
            defaultTextDirection,
            folderTopicPath,
            true,
        );

        const result: Note = new Note(noteFile, questions);
        return result;
    }
}
