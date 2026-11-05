import { moment } from "obsidian";

import { IBaseLocale } from "./base-locale";
import af from "./locale/af";
import ar from "./locale/ar";
import bn from "./locale/bn";
import cz from "./locale/cz";
import da from "./locale/da";
import de from "./locale/de";
import en from "./locale/en";
import enGB from "./locale/en-gb";
import es from "./locale/es";
import fr from "./locale/fr";
import he from "./locale/he";
import hi from "./locale/hi";
import id from "./locale/id";
import it from "./locale/it";
import ja from "./locale/ja";
import ko from "./locale/ko";
import mr from "./locale/mr";
import nl from "./locale/nl";
import no from "./locale/no";
import pl from "./locale/pl";
import pt from "./locale/pt";
import ptBR from "./locale/pt-br";
import ro from "./locale/ro";
import ru from "./locale/ru";
import sw from "./locale/sw";
import ta from "./locale/ta";
import te from "./locale/te";
import th from "./locale/th";
import tr from "./locale/tr";
import uk from "./locale/uk";
import ur from "./locale/ur";
import vi from "./locale/vi";
import zhCN from "./locale/zh-cn";
import zhTW from "./locale/zh-tw";

export interface ILocaleOption {
    language: string;
    languageName: string;
}

export interface ILocaleManager {
    currentLocale: string;
    readonly loadedLocale: string;
    readonly localeMap: { [k: string]: IBaseLocale };

    currentTranslation: () => IBaseLocale;
    currentLocaleName: () => string;
    currentLocaleCode: () => string;

    getLocaleOptionsList: () => ILocaleOption[];
}

export class LocaleManagerInstance {
    static instance: ILocaleManager;

    public static getInstance(): ILocaleManager {
        if (!LocaleManagerInstance.instance) {
            throw new Error("there is no QuestionDataStore instance.");
        }
        return LocaleManagerInstance.instance;
    }
}

export class LocaleManager implements ILocaleManager {
    public currentLocale: string; // The locale that is currently used
    public readonly loadedLocale: string; // The locale that is loaded by moment
    public readonly localeMap: { [k: string]: IBaseLocale }; // The locale map

    constructor() {
        // Load the current locale via moment
        this.loadedLocale = moment.locale();
        // Current locale is the same as the loaded locale if not changed elsewhere
        this.currentLocale = this.loadedLocale;
        this.localeMap = {
            af,
            ar,
            bn,
            cs: cz,
            da,
            de,
            en,
            "en-gb": enGB,
            es,
            fr,
            he,
            hi,
            id,
            it,
            ja,
            ko,
            mr,
            nl,
            nn: no,
            pl,
            pt,
            "pt-br": ptBR,
            ro,
            ru,
            sw,
            ta,
            te,
            th,
            tr,
            uk,
            ur,
            vi,
            "zh-cn": zhCN,
            "zh-tw": zhTW,
        };
    }

    /**
     * Gets the current translation.
     */
    public currentTranslation(): IBaseLocale {
        const currentLocale: string = LocaleManagerInstance.getInstance().currentLocale;
        const currentLocaleMap: IBaseLocale = this.localeMap[currentLocale];

        if (!currentLocaleMap) {
            console.warn(`SRS error: Locale ${currentLocale} not found.`);
        }

        return currentLocaleMap;
    }

    /**
     * Gets the current locale name.
     */
    public currentLocaleName(): string {
        return this.currentTranslation().languageName;
    }

    /**
     * Gets the current locale code.
     */
    public currentLocaleCode(): string {
        return this.currentTranslation().language;
    }

    /**
     * Gets the list of available locales.
     */
    public getLocaleOptionsList(): ILocaleOption[] {
        return Object.keys(this.localeMap).map((locale) => ({
            language: locale,
            languageName: this.localeMap[locale].languageName,
        }));
    }
}
