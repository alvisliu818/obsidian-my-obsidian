import { Question } from "../data/data-structures/card/questions/question";
import { TopicPath } from "../data/data-structures/deck/topic-path";
import { ISRNoteTFile } from "../data/data-structures/file/note-file";
import { SRSettings } from "../data/settings";
import { Note } from "./note";
import { NoteQuestionParser } from "./note-question-parser";
import { TextDirection } from "../utils/strings";

export class NoteFileLoader {
    fileText: string;
    fixesMade: boolean;
    noteTopicPath: TopicPath;
    noteFile: ISRNoteTFile;
    settings: SRSettings;

    constructor(settings: SRSettings) {
        this.settings = settings;
    }

    async load(
        noteFile: ISRNoteTFile,
        defaultTextDirection: TextDirection,
        folderTopicPath: TopicPath,
    ): Promise<Note | null> {
        this.noteFile = noteFile;

        const questionParser: NoteQuestionParser = new NoteQuestionParser(this.settings);

        const onlyKeepQuestionsWithTopicPath: boolean = true;
        const questionList: Question[] = await questionParser.createQuestionList(
            noteFile,
            defaultTextDirection,
            folderTopicPath,
            onlyKeepQuestionsWithTopicPath,
        );

        const result: Note = new Note(noteFile, questionList);
        return result;
    }
}
