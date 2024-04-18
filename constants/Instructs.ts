import { db } from '@db'
import { eq } from 'drizzle-orm'
import { instructs } from 'db/schema'
import { create } from 'zustand'
import { mmkv } from './mmkv'
import { Global } from './GlobalValues'

type InstructState = {
    data: InstructType | undefined
    load: (id: number) => Promise<void>
    loadCurrent: () => Promise<void>
    setData: (instruct: InstructType) => void
}

export type InstructListItem = {
    id: number
    name: string
}

export namespace Instructs {
    export const useInstruct = create<InstructState>((set, get: () => InstructState) => ({
        data: undefined,
        load: async (id: number) => {
            const data = await Database.read(id)
            set((state) => ({ ...state, data: data }))
            mmkv.set(Global.InstructID, id)
        },
        loadCurrent: async () => {
            const id = mmkv.getNumber(Global.InstructID)
            if (id) get().load(id)
        },
        setData: (instruct: InstructType) => {
            set((state) => ({ ...state, data: instruct }))
        },
    }))
    /*
    export const loadFile = async (name: string) => {
        return FS.readAsStringAsync(`${FS.documentDirectory}instruct/${name}.json`, {
            encoding: FS.EncodingType.UTF8,
        })
    }

    export const saveFile = async (name: string, preset: InstructType) => {
        return FS.writeAsStringAsync(
            `${FS.documentDirectory}instruct/${name}.json`,
            JSON.stringify(preset),
            { encoding: FS.EncodingType.UTF8 }
        )
    }

    export const deleteFile = async (name: string) => {
        return FS.deleteAsync(`${FS.documentDirectory}instruct/${name}.json`)
    }

    export const getFileList = async () => {
        return FS.readDirectoryAsync(`${FS.documentDirectory}instruct`)
    }

    export const uploadFile = async () => {
        return DocumentPicker.getDocumentAsync({ type: 'application/json' }).then((result) => {
            if (result.canceled) return
            const name = result.assets[0].name.replace(`.json`, '')
            return FS.copyAsync({
                from: result.assets[0].uri,
                to: `${FS.documentDirectory}/instruct/${name}.json`,
            })
                .then(() => {
                    return FS.readAsStringAsync(`${FS.documentDirectory}/instruct/${name}.json`, {
                        encoding: FS.EncodingType.UTF8,
                    })
                })
                .then((file) => {
                    const filekeys = Object.keys(JSON.parse(file))
                    const correctkeys = Object.keys(defaultInstruct())
                    const samekeys = filekeys.every((element, index) => {
                        return element === correctkeys[index]
                    })
                    if (!samekeys) {
                        return FS.deleteAsync(`${FS.documentDirectory}/instruct/${name}.json`).then(
                            () => {
                                throw new TypeError(`JSON file has invalid format`)
                            }
                        )
                    } else return name
                })
                .catch((error) => Logger.log(`Failed to load: ${error.message}`, true))
        })
    }*/

    // db

    export namespace Database {
        export const createDefault = async () => {
            await create(defaultInstruct)
        }

        export const create = async (instruct: InstructType): Promise<number> => {
            const { id, ...input } = instruct
            const [{ newid }, ...rest] = await db
                .insert(instructs)
                .values(input)
                .returning({ newid: instructs.id })
            return newid
        }

        export const read = async (id: number): Promise<InstructType | undefined> => {
            const instruct = await db.query.instructs.findFirst({
                where: eq(instructs.id, id),
            })
            return instruct
        }

        export const update = async (id: number, instruct: InstructType) => {
            await db.update(instructs).set(instruct).where(eq(instructs.id, id))
        }

        export const deleteEntry = async (id: number) => {
            await db.delete(instructs).where(eq(instructs.id, id))
        }

        export const readList = async (): Promise<Array<InstructListItem> | undefined> => {
            return await db.query.instructs.findMany({
                columns: {
                    id: true,
                    name: true,
                },
            })
        }
    }

    export const defaultInstruct: InstructType = {
        system_prompt: "Write {{char}}'s next reply in a chat between {{char}} and {{user}}.",
        system_prefix: '### Instruction: ',
        system_suffix: '\n',
        input_prefix: '### Instruction: ',
        input_suffix: '\n',
        output_prefix: '### Response: ',
        output_suffix: '\n',
        stop_sequence: '### Instruction',
        user_alignment_message: '',
        activation_regex: '',
        wrap: false,
        macro: false,
        names: false,
        names_force_groups: false,
        name: 'Default',
    }
}
/*
export type InstructType = {
    system_prompt: string
    input_sequence: string
    output_sequence: string
    first_output_sequence: string
    last_output_sequence: string
    system_sequence_prefix: string
    system_sequence_suffix: string

    stop_sequence: string
    separator_sequence: string
    wrap: boolean
    macro: boolean
    names: boolean
    names_force_groups: boolean
    activation_regex: string
    name: string
}

export const defaultInstruct = (): InstructType => {
    return {
        system_prompt:
            "Write {{char}}'s next reply in a roleplay chat between {{char}} and {{user}}.",
        input_sequence: '### Instruction: ',
        output_sequence: '### Response: ',
        first_output_sequence: '',
        last_output_sequence: '',
        system_sequence_prefix: '### Instruction: ',
        system_sequence_suffix: '',
        stop_sequence: '',
        separator_sequence: '',
        wrap: false,
        macro: false,
        names: false,
        names_force_groups: false,
        activation_regex: '',
        name: 'Default',
    }
}

export type InstructTypeST = {
    system_prompt: string
    input_sequence: string
    output_sequence: string
    first_output_sequence: string
    last_output_sequence: string
    system_sequence_prefix: string
    system_sequence_suffix: string
    stop_sequence: string
    wrap: boolean
    macro: boolean
    names: boolean
    names_force_groups: boolean
    activation_regex: string
    output_suffix: string
    input_suffix: string
    system_sequence: string
    system_suffix: string
    user_alignment_message: string
    last_system_sequence: string
    skip_examples: boolean
    system_same_as_user: boolean
    name: string
}*/

export type InstructType = {
    id?: number
    name: string
    system_prompt: string
    system_prefix: string
    system_suffix: string
    input_prefix: string
    input_suffix: string
    output_prefix: string
    output_suffix: string
    stop_sequence: string
    user_alignment_message: string
    activation_regex: string

    wrap: boolean
    macro: boolean
    names: boolean
    names_force_groups: boolean
}

const defaultInstructs: InstructType[] = []
