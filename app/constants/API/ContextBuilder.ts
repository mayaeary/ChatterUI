import { replaceMacros } from '@constants/Characters'
import { AppMode, AppSettings } from '@constants/GlobalValues'
import { Llama } from '@constants/LlamaLocal'
import { Tokenizer } from '@constants/Tokenizer'
import { Characters, Chats, Global, Instructs, Logger, mmkv } from '@globals'

import { APIConfiguration, APIValues } from './APIBuilder.types'

export const buildTextCompletionContext = (max_length: number) => {
    const delta = performance.now()

    const tokenizer =
        mmkv.getString(Global.AppMode) === AppMode.LOCAL
            ? Llama.useLlama.getState().tokenLength
            : Tokenizer.useTokenizer.getState().getTokenCount

    const messages = [...(Chats.useChat.getState().data?.messages ?? [])]

    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()

    const userCard = { ...Characters.useUserCard.getState().card }
    const currentCard = { ...Characters.useCharacterCard.getState().card }
    const userName = userCard?.name ?? ''
    const charName = currentCard?.name ?? ''

    const characterCache = Characters.useCharacterCard.getState().getCache(userName)
    const userCache = Characters.useUserCard.getState().getCache(charName)
    const instructCache = Instructs.useInstruct.getState().getCache(charName, userName)

    const user_card_data = (userCard?.description ?? '').trim()
    const char_card_data = (currentCard?.description ?? '').trim()
    let payload = ``

    // set suffix length as its always added
    let payload_length = instructCache.system_suffix_length
    if (currentInstruct.system_prefix) {
        payload += currentInstruct.system_prefix
        payload_length += instructCache.system_prefix_length
    }

    if (currentInstruct.system_prompt) {
        payload += `${currentInstruct.system_prompt}`
        payload_length += instructCache.system_prompt_length
    }
    if (char_card_data) {
        payload += char_card_data
        payload_length += characterCache.description_length
    }

    if (currentInstruct.scenario && currentCard?.scenario) {
        payload += currentCard.scenario
        payload_length += characterCache.scenario_length
    }

    if (currentInstruct.scenario && currentCard?.personality) {
        payload += currentCard.personality
        payload_length += characterCache.personality_length
    }

    if (user_card_data) {
        payload += user_card_data
        payload_length += userCache.description_length
    }
    // suffix must be delayed for example messages
    let message_acc = ``
    let message_acc_length = 0
    let is_last = true
    let index = messages.length - 1

    const wrap_string = `\n`
    const wrap_length = currentInstruct.wrap ? tokenizer(wrap_string) : 0

    // we use this to check if the first message is reached
    // this is needed to check if examples should be added
    let first_message_reached = false

    // we require lengths for names if use_names is enabled
    for (const message of messages.reverse()) {
        const swipe_len = Chats.useChat.getState().getTokenCount(index)
        const swipe_data = message.swipes[message.swipe_id]

        /** Accumulate total string length
         *  The context builder MUST retain context length below the
         *  context limit, especially for local gens to prevent truncation
         * **/

        let instruct_len = message.is_user
            ? instructCache.input_prefix_length
            : is_last
              ? instructCache.last_output_prefix_length
              : instructCache.output_suffix_length

        // for last message, we want to skip the end token to allow the LLM to generate

        if (!is_last)
            instruct_len += message.is_user
                ? instructCache.input_suffix_length
                : instructCache.output_suffix_length

        const timestamp_string = `[${swipe_data.send_date.toString().split(' ')[0]} ${swipe_data.send_date.toLocaleTimeString()}]\n`
        const timestamp_length = currentInstruct.timestamp ? tokenizer(timestamp_string) : 0

        const name_string = `${message.name} :`
        const name_length = currentInstruct.names ? tokenizer(name_string) : 0

        const shard_length = swipe_len + instruct_len + name_length + timestamp_length + wrap_length

        // check if within context window
        if (message_acc_length + payload_length + shard_length > max_length) {
            break
        }

        // apply strings

        let message_shard = message.is_user
            ? currentInstruct.input_prefix
            : is_last
              ? currentInstruct.last_output_prefix
              : currentInstruct.output_prefix

        if (currentInstruct.timestamp) message_shard += timestamp_string

        if (currentInstruct.names) message_shard += name_string

        message_shard += swipe_data.swipe

        if (!is_last) {
            message_shard += `${message.is_user ? currentInstruct.input_suffix : currentInstruct.output_suffix}`
        }

        if (currentInstruct.wrap) {
            message_shard += wrap_string
        }

        first_message_reached = index === 0

        // ensure no more is_last checks after this
        is_last = false
        message_acc_length += shard_length
        message_acc = message_shard + message_acc
        index--
    }

    const examples = currentCard?.mes_example
    if (
        first_message_reached &&
        currentInstruct.examples &&
        examples &&
        message_acc_length + payload_length + characterCache.examples_length < max_length
    ) {
        payload += examples
        message_acc_length += characterCache.examples_length
    }

    payload += currentInstruct.system_suffix

    payload = replaceMacros(payload + message_acc)
    Logger.log(`Approximate Context Size: ${message_acc_length + payload_length} tokens`)
    Logger.log(`${(performance.now() - delta).toFixed(2)}ms taken to build context`)
    if (mmkv.getBoolean(AppSettings.PrintContext)) Logger.log(payload)

    return payload
}

type Message = { role: string; [x: string]: string }

export const buildChatCompletionContext = (
    max_length: number,
    config: APIConfiguration,
    values: APIValues
): Message[] | undefined => {
    if (config.request.completionType.type !== 'chatCompletions') return
    const completionFeats = config.request.completionType
    const tokenizer =
        mmkv.getString(Global.AppMode) === AppMode.LOCAL
            ? Llama.useLlama.getState().tokenLength
            : Tokenizer.useTokenizer.getState().getTokenCount

    const messages = [...(Chats.useChat.getState().data?.messages ?? [])]
    const userCard = { ...Characters.useUserCard.getState().card }
    const currentCard = { ...Characters.useCharacterCard.getState().card }
    const currentInstruct = Instructs.useInstruct.getState().replacedMacros()

    const userName = userCard?.name ?? ''
    const charName = currentCard?.name ?? ''

    const characterCache = Characters.useCharacterCard.getState().getCache(userName)
    const userCache = Characters.useUserCard.getState().getCache(charName)
    const instructCache = Instructs.useInstruct.getState().getCache(charName, userName)

    const buffer = Chats.useChat.getState().buffer

    // Logic here is that if the buffer is empty, this is not a regen, hence can popped
    if (!buffer) messages.pop()
    let initial = `${currentInstruct.system_prompt}
    \n${userCard?.description ?? ''}
    \n${currentCard?.description ?? ''}`

    let total_length =
        instructCache.system_prompt_length +
        characterCache.description_length +
        userCache.description_length

    if (currentInstruct.scenario && currentCard?.scenario) {
        initial += currentCard.scenario
        total_length += characterCache.scenario_length
    }

    if (currentInstruct.scenario && currentCard?.personality) {
        initial += currentCard.personality
        total_length += characterCache.personality_length
    }

    const payload: Message[] = [
        { role: completionFeats.systemRole, [completionFeats.contentName]: replaceMacros(initial) },
    ]

    const messageBuffer: Message[] = config.features.useFirstMessage
        ? [{ role: completionFeats.userRole, [completionFeats.contentName]: values.firstMessage }]
        : []

    let index = messages.length - 1
    for (const message of messages.reverse()) {
        const swipe_data = message.swipes[message.swipe_id]
        // special case for claude, prefill may be useful!
        const timestamp_string = `[${swipe_data.send_date.toString().split(' ')[0]} ${swipe_data.send_date.toLocaleTimeString()}]\n`
        const timestamp_length = currentInstruct.timestamp ? tokenizer(timestamp_string) : 0

        const name_string = `${message.name} :`
        const name_length = currentInstruct.names ? tokenizer(name_string) : 0

        const len =
            Chats.useChat.getState().getTokenCount(index) +
            total_length +
            name_length +
            timestamp_length
        if (len > max_length) break

        const prefill = index === messages.length - 1 ? values.prefill : ''

        messageBuffer.push({
            role: message.is_user ? completionFeats.userRole : completionFeats.assistantRole,
            content: replaceMacros(prefill + message.swipes[message.swipe_id].swipe),
        })
        total_length += len
        index--
    }
    const output = [...payload, ...messageBuffer.reverse()]

    if (mmkv.getBoolean(AppSettings.PrintContext)) Logger.log(JSON.stringify(output))
    return output
}
