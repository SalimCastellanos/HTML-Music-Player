import EventEmitter from "events";
import {Directory} from "platform/platform";

const MIN_FILES_BEFORE_TRIGGER = 10;
const MAX_FILE_COUNT = Math.pow(2, 31);


function readEntries(reader) {
    return new Promise(resolve => reader.readEntries(resolve, () => resolve(null)));
}

function entryToFile(entry) {
    return new Promise(resolve => entry.file(resolve, () => resolve(null)));
}

export default class LocalFiles {
    async traverseEntries(entries, ee, context) {
        for (let i = 0; i < entries.length && context.currentFileCount < context.maxFileCount; ++i) {
            const entry = entries[i];
            if (entry.isFile) {
                const file = await entryToFile(entry);
                if (file) {
                    context.currentFileCount++;
                    if (context.stack.push(file) >= MIN_FILES_BEFORE_TRIGGER) {
                        ee.emit(`files`, context.stack.slice());
                        context.stack.length = 0;
                    }
                }
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                let results;
                do {
                    results = await readEntries(reader);
                    await this.traverseEntries(results, ee, context);
                } while (results.length > 0 && context.currentFileCount < context.maxFileCount);
            }
        }
    }

    async traverseFilesAndDirs(entries, ee, context) {
        for (let i = 0; i < entries.length && context.currentFileCount < context.maxFileCount; ++i) {
            const entry = entries[i];
            if (!(entry instanceof Directory) && entry.name && entry.size) {
                const file = entry;
                if (file) {
                    context.currentFileCount++;
                    if (context.stack.push(file) >= MIN_FILES_BEFORE_TRIGGER) {
                        ee.emit(`files`, context.stack.slice());
                        context.stack.length = 0;
                    }
                }
            } else if (entry instanceof Directory) {
                try {
                    const dir = entry;
                    const results = await Promise.resolve(dir.getFilesAndDirectories());
                    await this.traverseFilesAndDirs(results, ee, context);
                } catch (e) {
                    // NOOP
                }
            }
        }
    }

    fileEmitterFromFilesAndDirs(filesAndDirs) {
        const ret = new EventEmitter();
        const context = {
            stack: [],
            maxFileCount: MAX_FILE_COUNT,
            currentFileCount: 0
        };

        (async () => {
            try {
                await this.traverseFilesAndDirs(filesAndDirs, ret, context);
            } finally {
                if (context.stack.length) {
                    ret.emit(`files`, context.stack.slice());
                    context.stack.length = 0;
                }
                ret.emit(`end`);
            }
        })();
        return ret;
    }

    fileEmitterFromEntries(entries) {
        const ret = new EventEmitter();
        const context = {
            stack: [],
            maxFileCount: MAX_FILE_COUNT,
            currentFileCount: 0
        };

        (async () => {
            try {
                await this.traverseEntries(entries, ret, context);
            } finally {
                if (context.stack.length) {
                    ret.emit(`files`, context.stack.slice());
                    context.stack.length = 0;
                }
                ret.emit(`end`);
            }
        })();
        return ret;
    }
}
