<script setup>
import { onBeforeMount, onMounted, reactive, ref, computed } from 'vue';
import { useCheckCurrentUser, useInitTooltip, useGetAPIS, useGetLayoutStyle, useExport } from '../utils/utils';
import { currentUser, renderProfile, availableTags, apis, layoutStyle } from '../stores/globals';
import { useGetAvailableTags } from '../utils/daily';
import { useAuthHeaders } from '../utils/apiAuth'

/* MODULES */
import Parse from 'parse/dist/parse.min.js'
import Sortable from 'sortablejs';

/*********************
 * CONNECTIONS
 * Read-only status of what the SERVER is wired to (MT5 / database / R2).
 * Deliberately not editable here: these are credentials, and saving them from
 * the browser would mean storing the database password in MongoDB itself --
 * readable back by the logged-in user and copied into every R2 backup. They
 * stay in .env on the host, which never leaves it.
 *********************/
const connections = ref(null)
const connectionsError = ref(null)
const connectionsLoading = ref(false)

async function loadConnections() {
    connectionsLoading.value = true
    connectionsError.value = null
    try {
        const res = await fetch('/api/connections', { cache: 'no-store', headers: useAuthHeaders() })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        connections.value = await res.json()
    } catch (e) {
        connectionsError.value = e.message
        connections.value = null
    } finally {
        connectionsLoading.value = false
    }
}

/*********************
 * CHANGE PASSWORD
 *
 * Until now the only way to change the login password was TRADENOTE_PASSWORD in
 * .env plus a server restart -- which meant the password had to exist in plain
 * text in a file just to be changeable at all. With this, it lives only as a
 * bcrypt hash in the database and those env vars can be removed entirely.
 *
 * The current password is re-verified before the change even though the user is
 * already signed in: a session left open on a shared machine should not be
 * enough to take the account over.
 *********************/
const pw = reactive({ current: '', next: '', confirm: '' })
const pwBusy = ref(false)
const pwError = ref(null)
const pwDone = ref(false)

const pwProblem = computed(() => {
    if (!pw.current || !pw.next || !pw.confirm) return null   // not an error yet, just incomplete
    if (pw.next.length < 8) return 'New password must be at least 8 characters.'
    if (pw.next !== pw.confirm) return 'New password and confirmation do not match.'
    if (pw.next === pw.current) return 'New password is the same as the current one.'
    return null
})
const pwReady = computed(() => !!(pw.current && pw.next && pw.confirm) && !pwProblem.value)

async function changePassword() {
    pwError.value = null
    pwDone.value = false
    if (!pwReady.value) return
    pwBusy.value = true
    try {
        const username = currentUser.value && currentUser.value.username
        if (!username) throw new Error('Not signed in.')

        // Proves the old password, and fails cleanly if it is wrong.
        await Parse.User.logIn(username, pw.current)

        const user = Parse.User.current()
        user.set('password', pw.next)
        await user.save()

        // Parse revokes every session for the user when the password changes
        // (revokeSessionOnPasswordReset), so without logging back in the page
        // would keep a token the server has already thrown away and every
        // subsequent request would fail with "Invalid session token".
        await Parse.User.logIn(username, pw.next)

        pw.current = ''; pw.next = ''; pw.confirm = ''
        pwDone.value = true
    } catch (e) {
        pwError.value = e && e.message ? e.message : String(e)
    } finally {
        pwBusy.value = false
    }
}

let profileAvatar = null
let polygonKey = null
let databentoKey = null

const newAvailableTags = reactive([])
const availableTagsTags = reactive([])

let groupToDelete = ref(null)
let tagToDelete = ref(null)

let inputCount = ref(null)

onBeforeMount(async () => {
    await useGetAvailableTags()
    useGetAvailableTagsTags()
    await useGetAPIS()
    //await useGetLayoutStyle()
    //newAvailableTags = JSON.parse(JSON.stringify(availableTags)) //JSON.parse(JSON.stringify avoids the two arrays to be linked !!
    //console.log(" available tags " + JSON.stringify(availableTags))
    //console.log(" availableTagsTags "+JSON.stringify(availableTagsTags))
    for (let index = 0; index < availableTags.length; index++) {
        const element = JSON.parse(JSON.stringify(availableTags[index]))
        newAvailableTags.push(element)
    }
    //console.log(" newAvailableTags "+JSON.stringify(newAvailableTags))
    initSortable()


})

onMounted(async () => {
    await useInitTooltip()
    loadConnections()
})

/* PROFILE */
async function uploadProfileAvatar(event) {
    const file = event.target.files[0];
    profileAvatar = file
}


async function updateProfile() {
    console.log(" update profile")
    return new Promise(async (resolve, reject) => {
        console.log("\nUPDATING PROFILE")

        const parseObject = Parse.Object.extend("_User");
        const query = new Parse.Query(parseObject);
        query.equalTo("objectId", currentUser.value.objectId);
        const results = await query.first();
        if (results) {
            if (profileAvatar != null) {
                const parseFile = new Parse.File("avatar", profileAvatar);
                results.set("avatar", parseFile)
            }
            await results.save().then(async () => { //very important to have await or else too quick to update
                await useCheckCurrentUser()
                await (renderProfile.value += 1)
                console.log(" -> Profile updated")
            })
            //
        } else {
            alert("Update query did not return any results")
        }

        resolve()
    })
}

/*********************
 * TAGS
 *********************/

const useGetAvailableTagsTags = () => {
    availableTagsTags.splice(0)
    for (let index = 0; index < availableTags.length; index++) {
        const element = availableTags[index];
        for (let index = 0; index < element.tags.length; index++) {
            const el = element.tags[index];
            el.groupName = element.name
            availableTagsTags.push(el)
        }

    }
}

const useGetNewAvailableTags = () => {
    newAvailableTags.splice(0)
    for (let index = 0; index < availableTags.length; index++) {
        const element = availableTags[index];
        newAvailableTags.push(element)
    }
}
const initSortable = (param1) => {
    let idDivElToCreate

    for (let index = 0; index < availableTags.length; index++) {
        const element = availableTags[index];

        idDivElToCreate = document.getElementById(element.id)
        if (idDivElToCreate != null) {
            Sortable.create(idDivElToCreate, {
                group: {
                    name: "common",
                },
                animation: 100,
                onEnd: function ( /**Event*/ evt) {
                    let itemEl = evt.item; // dragged HTMLElement
                    let tagName = itemEl.querySelector('input').value
                    let tagId = itemEl.querySelector('input').id

                    let oldListId = evt.from.id
                    let newListId = evt.to.id
                    let oldIndex = evt.oldIndex
                    let newIndex = evt.newIndex

                    let oldListIndex = newAvailableTags.findIndex(obj => obj.id == oldListId)
                    let newListIndex = newAvailableTags.findIndex(obj => obj.id == newListId)

                    //console.log(" -> Tag " + tagName + " dragged from list " + oldListId + " on index " + oldIndex + " to list " + newListId + " on position " + newIndex)

                    //remove from old list
                    newAvailableTags[oldListIndex].tags.splice(oldIndex, 1)

                    //add to new new list
                    let temp = {}
                    temp.id = tagId
                    temp.name = tagName
                    newAvailableTags[newListIndex].tags.splice(newIndex, 0, temp)

                    //console.log(" -> New available tags " + JSON.stringify(newAvailableTags))
                    //console.log(" -> available tags " + JSON.stringify(availableTags))
                }


            });
        }
    }


}


const addNewGroup = async () => {
    let temp = {}
    const addToAvailableTags = async () => {
        return new Promise(async (resolve, reject) => {
            //console.log(" newAvailableTags " + JSON.stringify(newAvailableTags))

            if (newAvailableTags.length > 0) {
                const highestId = newAvailableTags.reduce((max, obj) => Math.max(max, parseInt(obj.id.replace("group_", ""), 10)), -Infinity);

                const getRandomHexColor = () => {
                    const red = Math.floor(Math.random() * 256);
                    const green = Math.floor(Math.random() * 256);
                    const blue = Math.floor(Math.random() * 256);
                    const hexColor = '#' + ((1 << 24) + (red << 16) + (green << 8) + blue).toString(16).slice(1);
                    return hexColor;
                }
                temp.id = "group_" + (highestId + 1).toString()
                temp.name = "GroupName"
                temp.color = getRandomHexColor()
                temp.tags = []
            }
            else {
                temp.id = "group_0"
                temp.name = "Ungrouped"
                temp.color = "#6c757d"
                temp.tags = []
            }
            newAvailableTags.push(temp)

            resolve()
        })
    }

    await addToAvailableTags()
    await updateSortedTags()
}

const addNewTag = async () => {
    let temp = {}
    const addToAvailableTags = async () => {
        return new Promise(async (resolve, reject) => {
            const findHighestIdNumber = (param) => {
                let highestId = -Infinity;
                //console.log("  -> Find highest number amongst " + JSON.stringify(param))
                param.forEach(innerArray => {
                    //console.log(" innerArray.tags " + JSON.stringify(innerArray.tags))
                    if (innerArray.tags.length == 0 && highestId == -Infinity) {
                        highestId = 0
                    } else {
                        innerArray.tags.forEach(obj => {
                            if (Number(obj.id.replace("tag_", "")) > highestId) {
                                highestId = Number(obj.id.replace("tag_", ""))
                            }
                        });
                    }
                });
                return highestId;
            }

            // Get the highest id number
            const highestIdNumber = findHighestIdNumber(newAvailableTags);
            console.log("  --> Highest number " + highestIdNumber);

            temp.id = "tag_" + (highestIdNumber + 1).toString()
            temp.name = "TagName"

            let ungroupedIndex = newAvailableTags.findIndex(obj => obj.id == 'group_0')
            newAvailableTags[ungroupedIndex].tags.push(temp)
            resolve()
        })
    }

    await addToAvailableTags()
    await updateSortedTags()
}

const deleteGroup = async () => {
    //first we move all the tags to the ungrouped group
    console.log(" -> Group to delete " + groupToDelete.value)
    if (groupToDelete.value !== null) {
        let toDeleteIndex = newAvailableTags.findIndex(obj => obj.id == groupToDelete.value)

        const moveTags = async () => {
            return new Promise(async (resolve, reject) => {
                //console.log(" newAvailableTags[toDeleteIndex].tags "+JSON.stringify(newAvailableTags[toDeleteIndex]))
                //console.log(" newAvailableTags[0].tags "+JSON.stringify(newAvailableTags[0]))

                //Case where group has no tags
                if (newAvailableTags[toDeleteIndex].tags.length == 0) {
                    resolve()
                }

                else {
                    for (let index = 0; index < newAvailableTags[toDeleteIndex].tags.length; index++) {
                        const element = newAvailableTags[toDeleteIndex].tags[index];
                        newAvailableTags[0].tags.push(element)
                        if ((index + 1) == newAvailableTags[toDeleteIndex].tags.length) {
                            resolve()
                        }
                    }
                }
            })
        }
        const spliceArrays = async () => {
            return new Promise(async (resolve, reject) => {
                newAvailableTags.splice(toDeleteIndex, 1)
                resolve()
            })
        }
        await moveTags()
        await spliceArrays()
        groupToDelete.value = null
        //console.log(" -> newAvailableTags " + JSON.stringify(newAvailableTags))
        await updateSortedTags()
    }
}

const deleteTag = async () => {
    console.log("\DELETING TAGS")
    console.log(" -> Tag to delete " + tagToDelete.value)

    if (tagToDelete.value !== null) {

        const deleteTagFromAvailableTags = async () => {
            return new Promise(async (resolve, reject) => {
                console.log("\DELETING FROM AVAILABLE TAGS")
                const parseObject = Parse.Object.extend("_User");
                const query = new Parse.Query(parseObject);
                query.equalTo("objectId", currentUser.value.objectId);
                const results = await query.first();
                if (results) {
                    //console.log(" results "+JSON.stringify(JSON.parse(JSON.stringify(results)).tags))
                    const userTags = JSON.parse(JSON.stringify(results)).tags
                    const findTagToDelete = () => {
                        for (let index = 0; index < userTags.length; index++) {
                            const element = userTags[index];
                            //console.log(" element "+JSON.stringify(element))
                            let tagIndex = element.tags.findIndex(obj => obj.id === tagToDelete.value)
                            if (tagIndex != -1) {
                                element.tags.splice(tagIndex, 1)
                                return
                            }

                        }
                    }

                    findTagToDelete()
                    //console.log(" -> userTags after deletion "+JSON.stringify(userTags))

                    results.set("tags", userTags)
                    await results.save().then(async () => {
                        console.log(" -> Deleted tag from available tags")
                        resolve()
                    })
                } else {
                    alert("Update query did not return any results")
                }
            })
        }

        const deleteTagFromTrades = async () => {
            return new Promise(async (resolve, reject) => {
                const parseObject = Parse.Object.extend("tags");
                const query = new Parse.Query(parseObject);
                const results = await query.find();
                if (results.length > 0) {
                    for (let i = 0; i < results.length; i++) {
                        const object = results[i];
                        const tradeTags = object.get('tags')
                        let tagIndex = tradeTags.findIndex(obj => obj == tagToDelete.value)
                        if (tagIndex != -1) {
                            tradeTags.splice(tagIndex, 1)
                            object.set("tags", tradeTags)
                            await object.save().then(async () => {
                                console.log("   ---> Deleted tag from trades")
                            })
                        }
                        //console.log(" -> TradeTags " + JSON.stringify(tradeTags))
                    }
                    resolve()
                } else {
                    console.log(" -> No existing trade tags to update")
                    resolve()
                }
            })
        }

        await deleteTagFromAvailableTags()
        await deleteTagFromTrades()
        await useGetAvailableTags()
        useGetAvailableTagsTags()
        useGetNewAvailableTags()
        initSortable()

    }

}

const inputGroupName = (param1, param2) => {
    newAvailableTags[param1].name = param2
    //console.log(" newAvailableTags " + JSON.stringify(newAvailableTags))
}

const inputGroupColor = (param1, param2) => {
    newAvailableTags[param1].color = param2
    //console.log(" newAvailableTags " + JSON.stringify(newAvailableTags))
}


const inputGroupTag = (param1, param2) => { //groupIndex, tag.id, value
    //console.log(" param 1 " + param1)
    //console.log(" param 2 " + param2)
    let groupIndex = -1;

    newAvailableTags.some((group, index) => {
        if (group.tags.some(tag => tag.id === param1)) {
            groupIndex = index;
            return true; // Stop iteration
        }
    });

    //console.log(groupIndex);

    let tagIndex = newAvailableTags[groupIndex].tags.findIndex(obj => obj.id == param1)

    //remove from old list
    newAvailableTags[groupIndex].tags.splice(tagIndex, 1)

    //add to new new list
    let temp = {}
    temp.id = param1
    temp.name = param2
    newAvailableTags[groupIndex].tags.splice(tagIndex, 0, temp)
}
const updateSortedTags = async () => {
    return new Promise(async (resolve, reject) => {
        console.log("\nUPDATING AVAILABLE TAGS")
        const parseObject = Parse.Object.extend("_User");
        const query = new Parse.Query(parseObject);
        const results = await query.first();
        if (results) {
            results.set("tags", newAvailableTags)
            await results.save().then(async () => {
                console.log(" -> Updated sorted tags")
                await useGetAvailableTags()
                useGetAvailableTagsTags()
                initSortable()
                resolve()
            })
        } else {
            alert("Update query did not return any results")
        }
    })
}

/*********************
 * APIS
 *********************/
const generateAPIKey = () => {
    console.log(" generating ")
    //create a base-36 string that contains 30 chars in a-z,0-9
    let apiKey = [...Array(30)]
        .map((e) => ((Math.random() * 36) | 0).toString(36))
        .join('');

    let index = apis.findIndex(obj => obj.provider === "tradeNote")
    if (index != -1) {
        apis[index].key = apiKey
    } else {
        let temp = {}
        temp.provider = "tradeNote"
        temp.label = "TradeNote"
        temp.key = apiKey
        apis.push(temp)
    }
    //console.log(" APIS " + JSON.stringify(apis))
}

/*********************
 * LAYOUT & SETUP
 *********************/
const inputDiaryTitles = (param1, param2) => {
    console.log(" param 1 " + param1)
    console.log(" param 2 " + param2)
    if (layoutStyle.diaryTitles != undefined && layoutStyle.diaryTitles.length > 0) {
        console.log("title exists")
        layoutStyle.diaryTitles.splice(param1, 0, param2);
        console.log(" Layout Style " + JSON.stringify(layoutStyle.diaryTitles))
    } else {
        console.log("title does not exists")
        layoutStyle.diaryTitles = []
        layoutStyle.diaryTitles.splice(param1, 0, param2);
        console.log(" Layout Style " + JSON.stringify(layoutStyle))
    }


}
const updateAPIS = async () => {
    return new Promise(async (resolve, reject) => {
        console.log("\nUPDATING APIS")
        console.log(" apis " + JSON.stringify(apis))
        const parseObject = Parse.Object.extend("_User");
        const query = new Parse.Query(parseObject);
        const results = await query.first();
        if (results) {
            if (polygonKey != null) {
                let index = apis.findIndex(obj => obj.provider === "polygon")
                if (index != -1) {
                    apis[index].key = polygonKey
                } else {
                    let temp = {}
                    temp.provider = "polygon"
                    temp.label = "Polygon"
                    temp.key = polygonKey
                    apis.push(temp)
                }
            }

            if (databentoKey != null) {
                let index = apis.findIndex(obj => obj.provider === "databento")
                if (index != -1) {
                    apis[index].key = databentoKey
                } else {
                    let temp = {}
                    temp.provider = "databento"
                    temp.label = "Databento"
                    temp.key = databentoKey
                    apis.push(temp)
                }
            }
            results.set("apis", apis)
            console.log(" apis " + JSON.stringify(apis))
            await results.save().then(async () => {
                console.log(" -> Updated apis")
                await useGetAPIS()
                resolve()
            })
        } else {
            alert("Update query did not return any results")
        }
    })
}

</script>

<template>
    <div class="row mt-2">
        <div class="row justify-content-md-center">
            <div class="col-12 col-md-8">
                <!--=============== Connections ===============-->
                <div class="settingsSection">
                    <p class="sectionTitle">Connections</p>
                    <p class="sectionHint">
                        Configured in <code>.env</code> on the server and connected automatically at
                        startup. Shown here read-only — tokens and the database password are never sent
                        to the browser, so they can't leak into the R2 backups.
                    </p>

                    <div v-if="connectionsError" class="connCard connBad">
                        Could not read connection status: {{ connectionsError }}
                    </div>

                    <div v-else-if="connections" class="connGrid">
                        <!-- MT5 -->
                        <div class="connCard">
                            <div class="connHead">
                                <span class="connName">MT5 feed</span>
                                <span class="connPill"
                                    v-bind:class="connections.mt5.liveFeed.connected ? 'ok' : 'off'">
                                    {{ connections.mt5.liveFeed.connected ? 'live' : 'no data' }}
                                </span>
                            </div>
                            <div class="connRow" v-if="connections.mt5.liveFeed.login">
                                <span>Account</span><b>{{ connections.mt5.liveFeed.login }}</b>
                            </div>
                            <div class="connRow">
                                <span>Open positions</span><b>{{ connections.mt5.liveFeed.positions }}</b>
                            </div>
                            <div class="connRow" v-if="connections.mt5.liveFeed.ageSeconds !== null">
                                <span>Last update</span><b>{{ connections.mt5.liveFeed.ageSeconds }}s ago</b>
                            </div>
                            <div class="connNote">
                                Needs MetaTrader 5 open on a Windows host running
                                <code>mt5-sync/mt5_live.py</code>.
                            </div>
                        </div>

                        <!-- Database -->
                        <div class="connCard">
                            <div class="connHead">
                                <span class="connName">Database</span>
                                <span class="connPill" v-bind:class="connections.database.isAtlas ? 'ok' : 'warn'">
                                    {{ connections.database.isAtlas ? 'Atlas' : 'local' }}
                                </span>
                            </div>
                            <div class="connRow">
                                <span>Host</span><b class="connMono">{{ connections.database.host || '—' }}</b>
                            </div>
                            <div class="connRow"><span>Database</span><b>{{ connections.database.name }}</b></div>
                            <div class="connNote" v-if="!connections.database.isAtlas">
                                Running on a local MongoDB container — only reachable from this machine.
                                Point <code>MONGO_URI</code> at an Atlas <code>mongodb+srv://</code> string
                                to host the app anywhere.
                            </div>
                        </div>

                        <!-- Storage -->
                        <div class="connCard">
                            <div class="connHead">
                                <span class="connName">Storage (R2)</span>
                                <span class="connPill" v-bind:class="connections.storage.r2Enabled ? 'ok' : 'off'">
                                    {{ connections.storage.r2Enabled ? 'connected' : 'off' }}
                                </span>
                            </div>
                            <div class="connRow" v-if="connections.storage.publicUrl">
                                <span>Public URL</span><b class="connMono">{{ connections.storage.publicUrl }}</b>
                            </div>
                            <div class="connNote" v-if="!connections.storage.r2Enabled">
                                Screenshots and backups fall back to the database while R2 is unset.
                            </div>
                        </div>
                    </div>

                    <div class="mt-2 mb-3">
                        <button class="btn btn-outline-primary btn-sm" v-on:click="loadConnections()"
                            :disabled="connectionsLoading">
                            <i class="uil uil-sync me-1"></i>{{ connectionsLoading ? 'Checking…' : 'Re-check' }}
                        </button>
                    </div>
                </div>

                <!--=============== Password ===============-->
                <div class="settingsSection">
                    <p class="sectionTitle">Password</p>
                    <p class="sectionHint">
                        Signed in as <b>{{ currentUser.username }}</b>. This updates the hash stored in the
                        database, so <code>TRADENOTE_USER</code> and <code>TRADENOTE_PASSWORD</code> can then be
                        removed from <code>.env</code> — leaving no copy of the password in plain text anywhere.
                    </p>

                    <div class="row align-items-center mt-2">
                        <div class="col-12 col-md-4">Current password</div>
                        <div class="col-12 col-md-8">
                            <input type="password" class="form-control" v-model="pw.current"
                                autocomplete="current-password" />
                        </div>
                    </div>
                    <div class="row align-items-center mt-2">
                        <div class="col-12 col-md-4">New password</div>
                        <div class="col-12 col-md-8">
                            <input type="password" class="form-control" v-model="pw.next"
                                autocomplete="new-password" />
                        </div>
                    </div>
                    <div class="row align-items-center mt-2">
                        <div class="col-12 col-md-4">Confirm new password</div>
                        <div class="col-12 col-md-8">
                            <input type="password" class="form-control" v-model="pw.confirm"
                                autocomplete="new-password" />
                        </div>
                    </div>

                    <div class="row mt-2">
                        <div class="col-12 col-md-4"></div>
                        <div class="col-12 col-md-8">
                            <div v-if="pwProblem" class="pwMsg pwBad">{{ pwProblem }}</div>
                            <div v-else-if="pwError" class="pwMsg pwBad">{{ pwError }}</div>
                            <div v-else-if="pwDone" class="pwMsg pwGood">
                                <i class="uil uil-check-circle me-1"></i>Password changed. Other devices signed
                                in with the old password have been signed out.
                            </div>
                        </div>
                    </div>

                    <div class="mt-3 mb-3">
                        <button type="button" class="btn btn-success" :disabled="!pwReady || pwBusy"
                            v-on:click="changePassword">
                            {{ pwBusy ? 'Changing…' : 'Change password' }}
                        </button>
                    </div>
                </div>

                <div class="settingsSection row align-items-center">
                    <p class="sectionTitle">Layout &amp; Style</p>

                    <!-- Prfile Picture -->
                    <div class="col-12 col-md-4">
                        Profile Picture
                    </div>
                    <div class="col-12 col-md-8">
                        <input type="file" @change="uploadProfileAvatar" />
                    </div>
                </div>

                <div class="mt-3 mb-3">
                    <button type="button" v-on:click="updateProfile" class="btn btn-success">Save</button>
                </div>


                <!--=============== API KEY ===============-->
                <div class="settingsSection row align-items-center">
                    <p class="sectionTitle">API Keys</p>
                    <div class="row">
                        <div class="col-12 col-md-4">TradeNote<i class="ps-1 uil uil-info-circle"
                                data-bs-toggle="tooltip"
                                data-bs-title="Your TradeNote API Key for using the TradeNote APIs."></i>
                        </div>
                        <div class="col-12 col-md-8">
                            <div class="row">
                                <div class="col-10">
                                    <input type="text" class="form-control"
                                        :value="apis.filter(obj => obj.provider === 'tradeNote').length > 0 && apis.filter(obj => obj.provider === 'tradeNote')[0].key ? apis.filter(obj => obj.provider === 'tradeNote')[0].key : ''"
                                        disabled />
                                </div>
                                <div class="col-2">
                                    <button type="button" v-on:click="generateAPIKey" class="btn btn-outline-light"><i
                                            class="uil uil-redo"></i></button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="row mt-2">
                        <div class="col-12 col-md-4">Polygon<i class="ps-1 uil uil-info-circle" data-bs-toggle="tooltip"
                                data-bs-title="Your Polygon API Key will be used to fill out automatically MFE prices when you add new trades as well as provide you with charts for your trades on daily page. Works with stocks and options."></i>
                        </div>
                        <div class="col-12 col-md-8">
                            <input type="text" class="form-control"
                                :value="apis.filter(obj => obj.provider === 'polygon').length > 0 && apis.filter(obj => obj.provider === 'polygon')[0].key ? apis.filter(obj => obj.provider === 'polygon')[0].key : ''"
                                @input="polygonKey = $event.target.value" />
                        </div>
                    </div>

                    <div class="row mt-2">
                        <div class="col-12 col-md-4">Databento<i class="ps-1 uil uil-info-circle"
                                data-bs-toggle="tooltip"
                                data-bs-title="Your Datanento API Key will be used to fill out automatically MFE prices when you add new trades as well as provide you with charts for your trades on daily page. Works with Futures."></i>
                        </div>
                        <div class="col-12 col-md-8">
                            <input type="text" class="form-control"
                                :value="apis.filter(obj => obj.provider === 'databento').length > 0 && apis.filter(obj => obj.provider === 'databento')[0].key ? apis.filter(obj => obj.provider === 'databento')[0].key : ''"
                                @input="databentoKey = $event.target.value" />
                        </div>
                    </div>

                </div>

                <div class="mt-3 mb-3">
                    <button type="button" v-on:click="updateAPIS" class="btn btn-success">Save</button>
                </div>



                <!--=============== TAGS ===============-->
                <div class="settingsSection row">
                    <p class="sectionTitle">Tags</p>
                    <p class="fw-lighter">Create tag groups and assign tags to your groups.</p>
                    <div class="row">
                        <div class="col-6">
                            <button type="button" v-on:click="addNewGroup" class="btn blueBtn btn-sm"><i
                                    class="uil uil-plus me-2"></i>Group</button>
                            <button v-show="newAvailableTags.length > 0" type="button" v-on:click="addNewTag"
                                class="btn blueBtn btn-sm ms-3"><i class="uil uil-plus me-2"></i>Tag</button>
                        </div>
                        <div class="col-6 text-end">
                            <button class="btn btn-secondary btn-sm mt-2 ms-4 dropdown-toggle" type="button"
                                data-bs-toggle="dropdown" aria-expanded="false">Export
                            </button>
                            <ul class="dropdown-menu">
                                <li><a class="dropdown-item"
                                        v-on:click="useExport('json', 'tags', null, availableTagsTags)">JSON</a>
                                </li>
                                <li><a class="dropdown-item"
                                        v-on:click="useExport('csv', 'tags', null, availableTagsTags)">CSV</a>
                                </li>
                            </ul>
                        </div>
                    </div>
                    <div v-for="(group, groupIndex) in availableTags" class="col-12 col-md-6">
                        <div class="availableTagsCard mt-3">
                            <div class="row align-items-center">
                                <div class="col-6">
                                    <h5 v-if="group.id == 'group_0'">{{ group.name }}</h5>
                                    <h5 v-else><input type="text" class="groupInput"
                                            v-on:input="inputGroupName(groupIndex, $event.target.value)"
                                            :value="group.name">
                                    </h5>
                                </div>
                                <div class="col-6 text-end">
                                    <input type="color" id="colorPicker" class=""
                                        v-on:input="inputGroupColor(groupIndex, $event.target.value)"
                                        :value="group.color">
                                </div>
                            </div>
                            <div class="availableTagsCardInputs" :id="group.id">
                                <div v-for="tag in group.tags">
                                    <input type="text" :style="{ backgroundColor: group.color }" class="availableTags"
                                        v-on:input="inputGroupTag(tag.id, $event.target.value)" :id="tag.id"
                                        :value="tag.name">
                                    <i class="uil uil-draggabledots"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="mt-3 mb-3">
                    <button type="button" v-on:click="updateSortedTags" class="btn btn-success">Save</button>
                </div>

                <!-- Delete Group -->
                <div class="mt-4 row align-items-center">
                    <div class="col-12 col-md-4">
                        Group to delete<i class="ps-1 uil uil-info-circle" data-bs-toggle="tooltip"
                            data-bs-title="Tags will be moved to Ungrouped."></i>
                    </div>
                    <div class="col-12 col-md-8">
                        <select v-on:input="groupToDelete = $event.target.value" class="form-select">
                            <option selected></option>
                            <option v-for="item in availableTags.filter(obj => obj.id !== 'group_0')" :key="item.id"
                                :value="item.id">{{ item.name }}
                            </option>
                        </select>
                    </div>
                </div>
                <div class="mt-3 mb-3">
                    <button type="button" v-on:click="deleteGroup" class="btn btn-danger">Delete</button>
                </div>

                <!-- Delete Tag -->
                <div class="mt-4 row align-items-center">
                    <div class="col-12 col-md-4">
                        Tag to delete
                    </div>
                    <div class="col-12 col-md-8">

                        <select v-on:input="tagToDelete = $event.target.value" class="form-select">
                            <option selected></option>
                            <option v-for="tag in availableTagsTags" :key="tag.id" :value="tag.id">
                                {{ tag.name }}
                            </option>
                        </select>

                    </div>
                </div>
                <div class="mt-3 mb-3">
                    <button type="button" v-on:click="deleteTag" class="btn btn-danger">Delete</button>
                </div>

            </div>
        </div>

    </div>
</template>
<style scoped>
.sectionHint {
    font-size: 0.85rem;
    color: var(--white-60);
}

.connGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0.75rem;
    padding: 0;
}

.connCard {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    padding: 0.85rem 1rem;
}

.connHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
}

.connName {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--white-60);
}

/* Status is the first thing scanned, so it gets colour and the rest stays neutral. */
.connPill {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 0.25rem;
    text-transform: lowercase;
}

.connPill.ok { color: #00CA73; background: rgba(0, 202, 115, 0.12); }
.connPill.warn { color: #f59e0b; background: rgba(245, 158, 11, 0.12); }
.connPill.off { color: #94a3b8; background: rgba(148, 163, 184, 0.12); }

.connRow {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.85rem;
    padding: 0.1rem 0;
}

.connRow span { color: var(--white-60); }

.connMono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    word-break: break-all;
    text-align: right;
}

.connNote {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.78rem;
    color: var(--white-60);
}

.connWarnText { color: #f59e0b; }

.connBad {
    color: #F6465D;
    font-size: 0.85rem;
}



.pwMsg {
    font-size: 0.85rem;
    margin-top: 0.5rem;
    max-width: 380px;
}

.pwBad { color: #F6465D; }
.pwGood { color: #00CA73; }


/* One rhythm for the whole page. Sections previously mixed mt-3, bare rows and a
   stray <hr>, so the gaps between them were all different sizes and two headings
   sat right on top of the block above. The divider is the wrapper's own top
   border, which cannot drift out of step with the spacing the way a separate
   <hr> did. */
.settingsSection {
    padding-top: 1.5rem;
    margin-top: 1.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

/* No border above the first one -- nothing to separate it from. */
.settingsSection:first-of-type {
    padding-top: 0;
    margin-top: 0;
    border-top: 0;
}

.sectionTitle {
    font-size: 1.05rem;
    font-weight: 700;
    margin-bottom: 0.75rem;
}

</style>
