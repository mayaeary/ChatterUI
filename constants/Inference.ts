import { Chats, useInference } from '@constants/Chat'
import { InstructType, Instructs } from '@constants/Instructs'
import { replaceMacros } from '@constants/Utils'
import { LlamaTokenizer } from './tokenizer'
import { Logger } from './Logger'
import { API } from './API'
import { Global } from './GlobalValues'
import { mmkv } from './mmkv'
import { Llama } from './llama'
import axios from 'axios'
import EventSource from 'react-native-sse'
import * as Application from 'expo-application'
import { Characters } from './Characters'

export const regenerateResponse = async () => {
    const charName = Characters.useCharacterCard.getState().card?.data.name
    const messagesLength = Chats.useChat.getState()?.data?.messages?.length ?? -1
    const message = Chats.useChat.getState()?.data?.messages?.[messagesLength - 1]

    Logger.log('Regenerate Response')
    if (!message?.is_user && messagesLength && messagesLength !== 1) {
        const replacement = message?.swipes[message.swipe_id].regen_cache ?? ''
        if (replacement) Chats.useChat.getState().setBuffer(replacement)
        await Chats.useChat.getState().updateEntry(messagesLength - 1, replacement, true, true)
    } else await Chats.useChat.getState().addEntry(charName ?? '', true, '')
    generateResponse()
}

export const continueResponse = () => {
    Logger.log(`Continuing Response`)
    Chats.useChat.getState().setRegenCache()
    Chats.useChat.getState().insertLastToBuffer()
    generateResponse()
}

export const generateResponse = async () => {
    if (useInference.getState().nowGenerating) {
        Logger.log('Generation already in progress', true)
        return
    }
    Chats.useChat.getState().startGenerating()
    Logger.log(`Obtaining response.`)
    const data = performance.now()
    const setAbortFunction = useInference.getState().setAbort
    const APIType = getString(Global.APIType)
    try {
        switch (APIType) {
            case API.KAI:
                await KAIresponse(setAbortFunction)
                break
            case API.HORDE:
                hordeResponse(setAbortFunction)
                break
            case API.MANCER:
                MancerResponseStream(setAbortFunction)
                break
            case API.TGWUI:
                TGWUIReponseStream(setAbortFunction)
                break
            case API.COMPLETIONS:
                CompletionsResponseStream(setAbortFunction)
                break
            case API.LOCAL:
                localStreamResponse(setAbortFunction)
                break
            case API.OPENROUTER:
                openRouterResponseStream(setAbortFunction)
                break
            case API.OPENAI:
                openAIResponseStream(setAbortFunction)
                break
            default:
                stopGenerating()
                Logger.log('Default inference case reached, this should never happen!', true)
        }
    } catch (error) {
        Logger.log(`Something went wrong: ${error}`, true)
        stopGenerating()
    }
    Logger.debug(`Time taken for generateResponse(): ${(performance.now() - data).toFixed(2)}ms`)
}

type AbortFunction = (fn: () => void) => void

// MMKV

const getObject = (key: string) => {
    return JSON.parse(mmkv.getString(key) ?? '{}')
}

const getString = (key: string) => {
    return mmkv.getString(key) ?? ''
}

const stopGenerating = () => {
    Chats.useChat.getState().stopGenerating()
}

export const hordeHeader = () => {
    return {
        'Client-Agent': `ChatterUI:${Application.nativeApplicationVersion}:https://github.com/Vali-98/ChatterUI`,
    }
}

// Context

/**
 *  Context Structure:
 *  System
 *      - System Prefix
 *      - System Prompt
 *      - Character Card
 *      - User Card
 *      - Example Messages (if max_length allows after Context)
 *      - System Suffix
 *  Context
 *      - Input Prefix + User Response + Input Suffix
 *      - Output Prefix + Bot Response + Output Suffix
 *      - Repeat
 *
 *  NOTE: Instruct formatting cannot be cached due to possibly using user and character names.
 *  Consider having a system capable of listening to changes in User / Character to update
 *  cached Instructs
 */

// Multiplier to token counts due to inaccuracy of tokenizer, TODO: Find better tokenizer base
const token_mult = 0.87

const buildContext = (max_length: number) => {
    const delta = performance.now()
    const messages = [...(Chats.useChat.getState().data?.messages ?? [])]

    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()

    const userCard = { ...Characters.useUserCard.getState().card }
    const userName = userCard.data?.name ?? ''

    const currentCard = { ...Characters.useCharacterCard.getState().card }
    const charName = currentCard.data?.name ?? ''

    const characterCache = Characters.useCharacterCard.getState().getCache(userName)
    const userCache = Characters.useUserCard.getState().getCache(charName)
    const instructCache = Instructs.useInstruct.getState().getCache(charName, userName)

    const user_card_data = (userCard?.data?.description ?? '').trim()
    const char_card_data = (currentCard?.data?.description ?? '').trim()
    let payload = ``
    // set suffix length as its always added
    let payload_length = instructCache.system_suffix_length * token_mult
    if (currentInstruct.system_prefix) {
        payload += currentInstruct.system_prefix
        payload_length += instructCache.system_prefix_length * token_mult
    }

    if (currentInstruct.system_prompt) {
        payload += `${currentInstruct.system_prompt}`
        payload_length += instructCache.system_prompt_length * token_mult
    }
    if (char_card_data) {
        payload += char_card_data
        payload_length += characterCache.description_length * token_mult
    }
    if (user_card_data) {
        payload += user_card_data
        payload_length += userCache.description_length * token_mult
    }
    // suffix must be delayed for example messages

    let message_acc = ``
    let message_acc_length = 0
    let is_last = true
    let index = messages.length - 1
    for (const message of messages?.reverse() ?? []) {
        const swipe_len = message.swipes[message.swipe_id].swipe
            ? Chats.useChat.getState().getTokenCount(index)
            : 0
        // for last message, we want to skip the end token to allow the LLM to generate
        const instruct_len = message.is_user
            ? instructCache.input_prefix_length + (is_last ? 0 : instructCache.input_suffix_length)
            : instructCache.input_suffix_length + (is_last ? 0 : instructCache.output_suffix_length)
        const shard_length = swipe_len + instruct_len
        if (message_acc_length + payload_length + shard_length > max_length) {
            break
        }

        let message_shard = `${message.is_user ? currentInstruct.input_prefix : currentInstruct.output_prefix}`
        if (currentInstruct.names) message_shard += message.name + ': '
        message_shard += message.swipes[message.swipe_id].swipe

        if (!is_last)
            message_shard += `${message.is_user ? currentInstruct.input_suffix : currentInstruct.output_suffix}`
        else is_last = false

        if (currentInstruct.wrap) {
            message_shard += `\n`
        }

        message_acc_length += shard_length * token_mult
        message_acc = message_shard + message_acc
        index--
    }
    const examples = currentCard.data?.mes_example
    if (examples) {
        if (message_acc_length + payload_length + characterCache.examples_length < max_length) {
            payload += examples
            message_acc_length += characterCache.examples_length * token_mult
        }
    }

    if (currentInstruct.system_suffix) {
        payload += ' ' + currentInstruct.system_suffix
        //message_acc_length += instructCache.system_suffix_length * token_mult
    }
    payload = replaceMacros(payload + message_acc)
    //Logger.log(`Payload size: ${LlamaTokenizer.encode(payload).length}`)
    Logger.log(
        `Approximate Context Size: ${(message_acc_length + payload_length).toFixed(0)} tokens`
    )
    Logger.log(`${(performance.now() - delta).toFixed(2)}ms taken to build context`)
    return payload
}

const buildChatCompletionContext = (max_length: number) => {
    const messages = [...(Chats.useChat.getState().data?.messages ?? [])]
    const userCard = { ...Characters.useUserCard.getState().card }
    const currentCard = { ...Characters.useCharacterCard.getState().card }
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const buffer = Chats.useChat.getState().buffer

    // Logic here is that if the buffer is empty, this is not a regen, hence can popped
    if (!buffer) messages.pop()
    const initial = `${currentInstruct.system_prompt}
    \n${userCard?.data?.description ?? ''}
    \n${currentCard?.data?.description ?? ''}`

    let total_length = LlamaTokenizer.encode(initial).length
    const payload = [{ role: 'system', content: replaceMacros(initial) }]
    const messageBuffer = []
    for (const message of messages.reverse()) {
        const len =
            LlamaTokenizer.encode(message.swipes[message.swipe_id].swipe).length + total_length
        if (len > max_length) break
        messageBuffer.push({
            role: message.is_user ? 'user' : 'assistant',
            content: replaceMacros(message.swipes[message.swipe_id].swipe),
        })
        total_length += len
    }
    return [...payload, ...messageBuffer.reverse()]
}

const constructStopSequence = (instruct: InstructType): Array<string> => {
    const sequence: Array<string> = []
    if (instruct.stop_sequence !== '')
        instruct.stop_sequence.split(',').forEach((item) => item !== '' && sequence.push(item))
    return sequence
}

const getRandomSeed = () => {
    return Math.floor(Math.random() * 99999)
}

const getSeed = (seed: string | number | undefined): number => {
    if (!seed) return getRandomSeed()

    if (typeof seed === 'string') {
        const newSeed = parseInt(seed)
        if (newSeed !== -1) return newSeed
        return getRandomSeed()
    }

    if (typeof seed === 'number') {
        if (seed === -1) return getRandomSeed()
        return seed
    }

    return getRandomSeed()
}

// Payloads

const constructKAIPayload = () => {
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()

    return {
        prompt: buildContext(preset.max_length),
        max_context_length: parseInt(preset.max_length),
        max_length: parseInt(preset.genamt),
        rep_pen: parseFloat(preset.rep_pen),
        rep_pen_range: parseInt(preset.rep_pen_range),
        temperature: parseFloat(preset.temp),
        tfs: parseFloat(preset.tfs),
        top_a: parseFloat(preset.top_a),
        top_k: parseInt(preset.top_k),
        top_p: parseFloat(preset.top_p),
        typical: parseFloat(preset.typical),
        sampler_order: [6, 0, 1, 3, 4, 2, 5],
        sampler_seed: getSeed(preset?.seed),
        stop_sequence: constructStopSequence(currentInstruct),
        mirostat: parseInt(preset.mirostat_mode),
        mirostat_tau: parseFloat(preset.mirostat_tau),
        mirostat_eta: parseFloat(preset.mirostat_eta),
        min_p: parseFloat(preset.min_p),
        grammar: preset.grammar ?? '',
        use_default_badwordids: !preset.ban_eos_token,
        dynatemp_range: preset.dynatemp_range,
        smooth_range: preset.smooth_range,
    }
}

const constructHordePayload = () => {
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const hordeModels = getObject(Global.HordeModels)
    const hordeWorkers = getObject(Global.HordeWorkers)

    const usedModels = hordeModels.map((item: any) => {
        return item.name
    })
    const usedWorkers = hordeWorkers.filter((item: any) =>
        item.models.some((model: any) => usedModels.includes(model))
    )
    const maxWorkerContext = Math.min.apply(
        null,
        usedWorkers.map((item: any) => {
            return item.max_context_length
        })
    )
    const usedResponseLength = Math.min.apply(
        null,
        usedWorkers.map((item: any) => {
            return item?.max_length
        })
    )

    Logger.log('Max worker context length: ' + maxWorkerContext)
    Logger.log('Max worker response length: ' + usedResponseLength)
    Logger.log('Models used: ' + usedModels)
    return {
        prompt: buildContext(maxWorkerContext),
        params: {
            n: 1,
            frmtadsnsp: false,
            frmtrmblln: false,
            frmtrmspch: false,
            frmttriminc: true,
            max_context_length: Math.min(parseInt(preset.max_length), maxWorkerContext),
            max_length: Math.min(parseInt(preset.genamt), usedResponseLength),
            rep_pen: preset.rep_pen,
            rep_pen_range: Math.min(parseInt(preset.rep_pen_range), maxWorkerContext, 4096),
            //rep_pen_slope: preset.rep_pen_slope,
            temperature: preset.temp,
            tfs: preset.tfs,
            top_a: preset.top_a,
            top_k: parseInt(preset.top_k),
            top_p: preset.top_p,
            typical: preset.typical,
            singleline: false,
            use_default_badwordsids: preset.ban_eos_token,
            stop_sequence: constructStopSequence(currentInstruct),
            min_p: preset.min_p,
        },
        trusted_workers: false,
        slow_workers: true,
        workers: [],
        worker_blacklist: false,
        models: usedModels,
        dry_run: false,
    }
}

const constructTGWUIPayload = () => {
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    return {
        stream: true,
        prompt: buildContext(preset.max_length),
        max_tokens: parseInt(preset.genamt),
        do_sample: preset.do_sample,
        temperature: parseFloat(preset.temp),
        top_p: parseFloat(preset.top_p),
        top_a: parseFloat(preset.top_a),
        top_k: parseFloat(preset.top_k),
        min_p: preset.min_p,
        typical_p: parseFloat(preset.typical),
        epsilon_cutoff: parseFloat(preset.epsilon_cutoff),
        eta_cutoff: parseFloat(preset.eta_cutoff),
        tfs: parseFloat(preset.tfs),
        repetition_penalty: parseFloat(preset.rep_pen),
        repetition_penalty_range: parseInt(preset.rep_pen_range),
        min_length: parseInt(preset.min_length),
        no_repeat_ngram_size: parseInt(preset.no_repeat_ngram_size),
        num_beams: parseInt(preset.num_beams),
        penalty_alpha: parseFloat(preset.penalty_alpha),
        length_penalty: parseFloat(preset.length_penalty),
        early_stopping: preset.early_stopping,
        mirostat_mode: parseInt(preset.mirostat_mode),
        mirostat_eta: parseFloat(preset.mirostat_eta),
        mirostat_tau: parseFloat(preset.mirostat_tau),
        add_bos_token: preset.add_bos_token,
        truncation_length: parseInt(preset.truncation_length),
        ban_eos_token: preset.ban_eos_token,
        skip_special_tokens: preset.skip_special_tokens,
        stopping_strings: constructStopSequence(currentInstruct),
        seed: getSeed(preset?.seed),
        guidance_scale: preset.guidance_scale,
        negative_prompt: preset.negative_prompt,
        temperature_last: parseFloat(preset.min_p) !== 1,
        dynamic_temperature: parseFloat(preset.dynatemp_range) > 0,
        dynatemp_low: parseFloat(preset.temp) - parseFloat(preset.dynatemp_range) / 2,
        dynatemp_hight: parseFloat(preset.temp) + parseFloat(preset.dynatemp_range) / 2,
        dynatemp_exponent: 0.5,
        smoothing_factor: preset.smoothing_factor,
    }
}

const constructMancerPayload = () => {
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const mancerModel = getObject(Global.MancerModel)

    const context_len = Math.min(preset.max_length, mancerModel.limits.context)
    const gen_len = Math.min(preset.genamt, mancerModel.limits.completion)

    return {
        prompt: buildContext(context_len),
        model: mancerModel.id,
        stream: true,
        max_tokens: context_len,
        min_tokens: gen_len,
        stop: constructStopSequence(currentInstruct),
        //"logit_bias": {},
        temperature: preset.temp,
        repetition_penalty: preset.rep_pen,
        presence_penalty: preset.presence_pen,
        frequency_penalty: preset.freq_pen,
        top_k: preset.top_k,
        top_p: preset.top_p,
        top_a: preset.top_a,
        min_p: preset.min_p,
    }
}

const constructCompletionsPayload = () => {
    const completionsModel = getObject(Global.CompletionsModel)
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()

    return {
        stream: true,
        max_context_length: preset.max_length,
        max_tokens: preset.genamt,
        prompt: buildContext(preset.max_length),
        rep_pen: preset.rep_pen,
        repetition_penalty: preset.rep_pen,
        rep_pen_range: preset.rep_pen_range,
        model: completionsModel.id,
        temperature: preset.temp,
        tfs: preset.tfs,
        top_a: preset.top_a,
        top_k: Math.round(preset.top_k),
        top_p: preset.top_p,
        min_p: preset.min_p,
        typical: preset.typical,
        ignore_eos: preset.ban_eos_token,
        mirostat_mode: preset.mirostat_mode,
        mirostat_tau: preset.mirostat_tau,
        mirostat_eta: preset.mirostat_eta,
        grammar: preset.grammar_string,
        seed: getSeed(preset?.seed),
        sampler_order: [6, 0, 1, 3, 4, 2, 5],
        stop: constructStopSequence(currentInstruct),
        frequency_penalty: preset.freq_pen,
        presence_penalty: preset.presence_pen,
        smoothing_factor: preset.smoothing_factor,
    }
}

const constructLocalPayload = () => {
    const preset = getObject(Global.PresetData)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const localPreset = getObject(Global.LocalPreset)
    return {
        prompt: buildContext(preset.max_length),
        grammar: preset.grammar ?? '',
        stop: constructStopSequence(currentInstruct),

        n_predict: preset.genamt,
        n_threads: localPreset.threads,

        temperature: preset.temp,
        repeat_penalty: preset.rep_pen,
        presence_penalty: preset.presence_pen,
        frequency_penalty: preset.freq_pen,
        mirostat: preset.mirostat_mode,
        mirostat_tau: preset.mirostat_tau,
        mirostat_eta: preset.mirostat_eta,
        top_k: preset.top_k,
        top_p: preset.top_p,
        tfs_z: preset.tfs,
        typical_p: preset.typical,
        min_p: preset.min_p,
        seed: getSeed(preset?.seed),
    }
}

const constructOpenRouterPayload = () => {
    const openRouterModel = getObject(Global.OpenRouterModel)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const preset = getObject(Global.PresetData)
    return {
        messages: buildChatCompletionContext(openRouterModel.context_length),
        model: openRouterModel.id,
        frequency_penalty: preset.freq_pen,
        max_tokens: preset.genamt,
        presence_penalty: preset.presence_pen,
        response_format: { type: 'json_object' },
        seed: getSeed(preset?.seed),
        stop: constructStopSequence(currentInstruct),
        stream: true,
        temperature: preset.temp,
        top_p: preset.top_p,
        top_k: preset.top_a,
    }
}

const constructOpenAIPayload = () => {
    const openAIModel = getObject(Global.OpenAIModel)
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()
    const preset = getObject(Global.PresetData)
    return {
        messages: buildChatCompletionContext(preset.max_length),
        model: openAIModel.id,
        max_tokens: preset.genamt,
        frequency_penalty: preset.freq_pen,
        presence_penalty: preset.presence_pen,
        seed: getSeed(preset?.seed),
        stop: constructStopSequence(currentInstruct),
        stream: true,
        temperature: preset.temp,
        top_p: preset.top_p,
    }
}

// Fetch Response

const KAIresponse = async (setAbortFunction: AbortFunction) => {
    const endpoint = getString(Global.KAIEndpoint)
    Logger.log(`Using endpoint: KAI`)

    readableStreamResponse(
        new URL('/api/extra/generate/stream', endpoint).toString(),
        JSON.stringify(constructKAIPayload()),
        (item) => {
            return JSON.parse(item).token
        },
        setAbortFunction,
        () => {
            axios
                .create({ timeout: 1000 })
                .post(new URL('/api/extra/abort', endpoint).toString())
                .catch(() => {
                    Logger.log(`Abort signal failed`)
                })
        }
    )
}

const hordeResponse = async (setAbortFunction: AbortFunction) => {
    const hordeKey = getString(Global.HordeKey)
    const hordeModels = getObject(Global.HordeModels)

    let generation_id = ''
    let aborted = false

    if (hordeModels.length === 0) {
        Logger.log(`No Models Selected`, true)
        stopGenerating()
        return
    }

    setAbortFunction(() => {
        aborted = true
        if (generation_id !== null)
            fetch(`https://aihorde.net/api/v2/generate/text/status/${generation_id}`, {
                method: 'DELETE',
                headers: {
                    ...hordeHeader(),
                    accept: 'application/json',
                    'Content-Type': 'application/json',
                },
            }).catch((error) => {
                Logger.log(error)
            })
        stopGenerating()
    })

    Logger.log(`Using Horde`)

    const payload = constructHordePayload()
    const request = await fetch(`https://aihorde.net/api/v2/generate/text/async`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
            apikey: hordeKey,
            ...hordeHeader(),
            accept: 'application/json',
            'content-type': 'application/json',
        },
    })

    if (request.status === 401) {
        Logger.log(`Invalid API Key`, true)
        stopGenerating()
        return
    }
    if (request.status !== 202) {
        Logger.log(`Request failed.`)
        stopGenerating()
        const body = await request.json()
        Logger.log(JSON.stringify(body))
        for (const e of body.errors) Logger.log(e)
        return
    }

    const body = await request.json()
    generation_id = body.id
    let result = undefined

    do {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        if (aborted) return

        Logger.log(`Checking...`)
        const response = await fetch(
            `https://aihorde.net/api/v2/generate/text/status/${generation_id}`,
            {
                method: 'GET',
                headers: {
                    ...hordeHeader(),
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
            }
        )

        if (response.status === 400) {
            Logger.log(`Response failed.`)
            stopGenerating()
            Logger.log((await response.json())?.message)
            return
        }

        result = await response.json()
    } while (!result.done)

    if (aborted) return

    const replace = RegExp(
        constructReplaceStrings()
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join(`|`),
        'g'
    )

    Chats.useChat.getState().setBuffer(result.generations[0].text.replaceAll(replace, ''))
    stopGenerating()
}

const TGWUIReponseStream = async (setAbortFunction: AbortFunction) => {
    const endpoint = getString(Global.TGWUIStreamingEndpoint)

    readableStreamResponse(
        new URL('/v1/completions', endpoint).toString(),
        JSON.stringify(constructTGWUIPayload()),
        (item) => {
            return JSON.parse(item).choices[0].text
        },
        setAbortFunction
    )
}

const MancerResponseStream = async (setAbortFunction: AbortFunction) => {
    const mancerKey = getString(Global.MancerKey)
    const mancerModel = getObject(Global.MancerModel)

    const check = await fetch(`https://neuro.mancer.tech/oai/v1/models/${mancerModel.id}`, {
        method: 'GET',
        headers: { 'X-API-KEY': mancerKey },
    })

    if (check.status !== 200) {
        Logger.log(await check.json())
        stopGenerating()
        Logger.log(`Invalid Model or API key!`, true)
        return
    }

    readableStreamResponse(
        `https://neuro.mancer.tech/oai/v1/completions`,
        JSON.stringify(constructMancerPayload()),
        (item) => {
            if (item === 'data: [DONE]') return ''
            return JSON.parse(item).choices[0].text
        },
        setAbortFunction,
        () => {},
        { 'X-API-KEY': getString(Global.MancerKey) }
    )
}

const CompletionsResponseStream = async (setAbortFunction: AbortFunction) => {
    const endpoint = getString(Global.CompletionsEndpoint)

    readableStreamResponse(
        new URL('/v1/completions', endpoint).toString(),
        JSON.stringify(constructCompletionsPayload()),
        (item) => {
            const output = JSON.parse(item)
            return output?.choices?.[0]?.text ?? output?.content ?? ''
        },
        setAbortFunction,
        () => {},
        { Authorization: `Bearer ${getString(Global.CompletionsKey)}` }
    )
}

const openRouterResponseStream = async (setAbortFunction: AbortFunction) => {
    readableStreamResponse(
        'https://openrouter.ai/api/v1/chat/completions',
        JSON.stringify(constructOpenRouterPayload()),
        (item) => {
            return JSON.parse(item).choices[0]?.delta?.content ?? ''
        },
        setAbortFunction,
        () => {},
        { Authorization: `Bearer ${getString(Global.OpenRouterKey)}` }
    )
}

const openAIResponseStream = async (setAbortFunction: AbortFunction) => {
    readableStreamResponse(
        'https://api.openai.com/v1/chat/completions',
        JSON.stringify(constructOpenAIPayload()),
        (item) => {
            return JSON.parse(item).choices[0]?.delta?.content ?? ''
        },
        setAbortFunction,
        () => {},
        { Authorization: `Bearer ${getString(Global.OpenAIKey)}` }
    )
}

const constructReplaceStrings = (): Array<string> => {
    const currentInstruct: InstructType = Instructs.useInstruct.getState().replacedMacros()
    // default stop strings defined instructs
    const stops: Array<string> = constructStopSequence(currentInstruct)
    // additional stop strings based on context configuration
    const output: Array<string> = []

    if (currentInstruct.names) {
        const userName = Characters.useCharacterCard.getState().card?.data.name ?? ''
        const charName: string = Characters.useCharacterCard.getState()?.card?.data?.name ?? ''
        output.push(`${userName} :`)
        output.push(`${charName} :`)
    }
    return [...stops, ...output]
}

const localStreamResponse = async (setAbortFunction: AbortFunction) => {
    const replace = RegExp(
        constructReplaceStrings()
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join(`|`),
        'g'
    )

    setAbortFunction(async () => {
        Llama.stopCompletion()
    })

    const payload = constructLocalPayload()
    Llama.completion(payload, (text: string) => {
        const output = Chats.useChat.getState().buffer + text
        Chats.useChat.getState().setBuffer(output.replaceAll(replace, ''))
    })
        .then(() => {
            stopGenerating()
        })
        .catch((error) => {
            Logger.log(`Failed to generate locally: ${error}`, true)
            stopGenerating()
        })
}

type KeyHeader = {
    [key: string]: string
}

const readableStreamResponse = async (
    endpoint: string,
    payload: Object,
    jsonreader: (event: any) => string,
    setAbortFunction: AbortFunction,
    abort_func = () => {},
    header: KeyHeader = {}
) => {
    const replace = RegExp(
        constructReplaceStrings()
            .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join(`|`),
        'g'
    )

    const es = new EventSource(endpoint, {
        method: 'POST',
        body: payload,
        headers: {
            accept: 'application/json',
            'Content-Type': 'application/json',
            ...header,
        },
        pollingInterval: 0,
        withCredentials: header?.['X-API-KEY'] !== undefined || header?.Authorization !== undefined,
    })

    const closeStream = () => {
        Logger.debug('Running close stream')
        stopGenerating()
        es.removeAllEventListeners()
        es.close()
    }

    useInference.getState().setAbort(async () => {
        Logger.debug('Running abort')
        closeStream()
        abort_func()
    })

    es.addEventListener('message', (event) => {
        if (event.data === `[DONE]`) {
            es.close()
            return
        }
        const text = jsonreader(event.data)
        const output = Chats.useChat.getState().buffer + text
        Chats.useChat.getState().setBuffer(output.replaceAll(replace, ''))
    })

    es.addEventListener('error', (event) => {
        if ('message' in event) {
            Logger.log('Generation Failed. Check Logs', true)
            Logger.log(`An error occured : ${event?.message ?? ''}`)
        }
        closeStream()
    })
    es.addEventListener('close', (event) => {
        closeStream()
        Logger.log('EventSource closed')
    })
}
