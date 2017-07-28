export function iDbPromisify(ee) {
    return new Promise((resolve, reject) => {
        ee.onerror = function(event) {
            reject(event.target.transaction.error || ee.error);
        };
        ee.onsuccess = function(event) {
            resolve(event.target.result);
        };
    });
}

export function iDbPromisifyCursor(cursor, callback) {
    return new Promise((resolve, reject) => {
        cursor.onerror = function(event) {
            reject(event.target.transaction.error || cursor.error);
        };

        cursor.onsuccess = async function(event) {
            if (!event.target.result) {
              resolve();
            } else {
              try {
                const finished = await callback(event.target.result);
                if (finished === true) {
                  resolve();
                }
              } catch (e) {
                reject(e);
              }
            }
        };
    });
}

function applyIndexSpecToStore(store, indexSpec) {
    const indexNames = new Set([].slice.call(store.indexNames));

    for (const indexName of Object.keys(indexSpec)) {
        if (!indexNames.has(indexName)) {
            const spec = indexSpec[indexName];
            store.createIndex(indexName, spec.keyPath, spec);
        }
    }

    for (const indexName of indexNames) {
        if (!indexSpec.hasOwnProperty(indexName)) {
            store.deleteIndex(indexName);
        }
    }
}

export function applyStoreSpec(transaction, storeSpec) {
    const {db} = transaction;
    const storeNames = new Set([].slice.call(transaction.objectStoreNames));
    const ret = {};

    for (const storeName of Object.keys(storeSpec)) {
        const spec = storeSpec[storeName];
        if (!storeNames.has(storeName)) {
            ret[storeName] = db.createObjectStore(storeName, spec);
        } else {
            ret[storeName] = transaction.objectStore(storeName);
        }

        applyIndexSpecToStore(ret[storeName], spec.indexSpec || {});
    }

    for (const storeName of storeNames) {
        if (!storeSpec.hasOwnProperty(storeName)) {
            db.deleteObjectStore(storeName);
        }
    }

    return ret;
}
