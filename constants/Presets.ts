import * as FS from 'expo-file-system'
import * as DocumentPicker from 'expo-document-picker'
import { ToastAndroid } from 'react-native'
import { API } from './API'

export namespace Presets {

export const APIFields : any = {
    [API.KAI] : [],
    [API.TGWUI] : [],
    [API.HORDE] : [],
    [API.MANCER] : [],
    [API.COMPLETIONS] : []
}


export const defaultPreset = () => {
    return {
        "temp": 0.5,
        "top_p": 0.9,
        "top_k": 0,
        "top_a": 0,
        // merged from KAI

        "min_p" : 0.05,
        "typical" : 0.01,
        "single_line" : false,
        "sampler_order" : [6,0,1,3,4,2,5],
        "seed": -1,

        //
        "tfs": 1,
        "epsilon_cutoff": 0,
        "eta_cutoff": 0,
        "typical_p": 1,
        "rep_pen": 1.1,
        "rep_pen_range": 0,
        "rep_pen_slope": 1,
        "no_repeat_ngram_size": 20,
        "penalty_alpha": 0,
        "num_beams": 1,
        "length_penalty": 1,
        "min_length": 0,
        "encoder_rep_pen": 1,
        "freq_pen": 0,
        "presence_pen": 0,
        "do_sample": true,
        "early_stopping": false,
        "add_bos_token": true,
        "truncation_length": 2048,
        "ban_eos_token": false,
        "skip_special_tokens": true,
        "streaming": true,
        "mirostat_mode": 0,
        "mirostat_tau": 5,
        "mirostat_eta": 0.1,
        "guidance_scale": 1,
        "negative_prompt": "",
        "grammar_string": "",
        "banned_tokens": "",
        "type": "ooba",
        "rep_pen_size": 0,
        "genamt": 256,
        "max_length": 4096
    }
}

const fixPreset = async (preset : any, filename = '') => {
    const existingKeys = Object.keys(preset)
    const targetPreset : any = defaultPreset()
    const defaultKeys = Object.keys(targetPreset)
    let samekeys = true
    defaultKeys.map( (key : any) => {
        if(existingKeys.includes(key)) return
        preset[key] = targetPreset[key]
        samekeys = false
    })
    if(filename !== '')
        await saveFile(filename, preset)
    if(!samekeys)
        console.log(`Preset fixed!`)
    return  JSON.stringify(preset)
}

export const loadFile = async (name : string) => {    
    return FS.readAsStringAsync(`${FS.documentDirectory}presets/${name}.json`, {encoding: FS.EncodingType.UTF8}).then((file) => {
        return fixPreset(JSON.parse(file), name)
    })
}

export const saveFile = async (name : string, preset : Object) => {
    return FS.writeAsStringAsync(`${FS.documentDirectory}presets/${name}.json`, JSON.stringify(preset), {encoding:FS.EncodingType.UTF8})
}

export const deleteFile = async (name : string) => {
    return FS.deleteAsync(`${FS.documentDirectory}presets/${name}.json`)
}

export const getFileList = async () => {
    return FS.readDirectoryAsync(`${FS.documentDirectory}presets/`)
}

export const uploadFile= async () => {
    return DocumentPicker.getDocumentAsync({type:['application/*']}).then((result) => {
        if(result.canceled || !result.assets[0].name.endsWith('json') && !result.assets[0].name.endsWith('settings')) {
            ToastAndroid.show(`Invalid File Type!`, 3000)    
            return
        }
        let name = result.assets[0].name.replace(`.json`, '').replace('.settings', '')
        return FS.copyAsync({
            from: result.assets[0].uri, 
            to: `${FS.documentDirectory}/presets/${name}.json`
        }).then(() => {
            return FS.readAsStringAsync(`${FS.documentDirectory}/presets/${name}.json`, {encoding: FS.EncodingType.UTF8})
        }).then(async (file) => {
            await fixPreset(JSON.parse(file), name)
            return name
        }).catch(error => {
            console.log(error)
            ToastAndroid.show(error.message, 2000)
        })
    })
}

}