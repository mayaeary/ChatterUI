import { FontAwesome } from '@expo/vector-icons'
import { Characters, Logger, Style } from '@globals'
import { Stack, usePathname } from 'expo-router'
import { useEffect, useState } from 'react'
import { SafeAreaView, View, Text, StyleSheet, FlatList } from 'react-native'
import { TouchableOpacity } from 'react-native-gesture-handler'
import Animated, { SequencedTransition } from 'react-native-reanimated'

import CharacterListing from './CharacterListing'
import CharacterNewMenu from './CharacterNewMenu'
import CharactersEmpty from './CharactersEmpty'

type CharInfo = {
    name: string
    id: number
    image_id: number
    last_modified: number
    tags: string[]
    latestSwipe?: string
    latestName?: string
    latestChat?: number
}

enum SortType {
    RECENT,
    ALPHABETICAL,
}

const sortModified = (item1: CharInfo, item2: CharInfo) => {
    return item2.last_modified - item1.last_modified
}

const sortAlphabetical = (item1: CharInfo, item2: CharInfo) => {
    return -item2.name.localeCompare(item1.name)
}

type SortButtonProps = {
    sortType: SortType
    currentSortType: SortType
    label: string
    onPress: () => void | Promise<void>
}

const SortButton: React.FC<SortButtonProps> = ({ sortType, currentSortType, label, onPress }) => {
    return (
        <TouchableOpacity
            onPress={onPress}
            style={sortType === currentSortType ? styles.sortButtonActive : styles.sortButton}>
            <Text
                style={
                    sortType === currentSortType
                        ? styles.sortButtonTextActive
                        : styles.sortButtonText
                }>
                {label}
            </Text>
        </TouchableOpacity>
    )
}

type CharacterListProps = {
    showHeader: boolean
}

const CharacterList: React.FC<CharacterListProps> = ({ showHeader }) => {
    'use no memo'
    const [characterList, setCharacterList] = useState<CharInfo[]>([])
    const [nowLoading, setNowLoading] = useState(false)

    const [sortType, setSortType] = useState<SortType>(SortType.RECENT)

    const getCharacterList = async () => {
        try {
            const list = await Characters.db.query.cardList('character', 'modified')
            setCharacterList(list)
        } catch (error) {
            Logger.log(`Could not retrieve characters.\n${error}`, true)
        }
    }

    useEffect(() => {
        getCharacterList()
    }, [usePathname()])

    return (
        <SafeAreaView style={{ paddingVertical: 16, paddingHorizontal: 8, flex: 1 }}>
            <Stack.Screen
                options={{
                    title: '',
                    ...(showHeader
                        ? {
                              headerRight: () => (
                                  <CharacterNewMenu
                                      nowLoading={nowLoading}
                                      setNowLoading={setNowLoading}
                                      getCharacterList={getCharacterList}
                                  />
                              ),
                          }
                        : {}),
                }}
            />
            <View
                style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingHorizontal: 16,
                    paddingBottom: 12,
                }}>
                <View
                    style={{
                        columnGap: 12,
                        flexDirection: 'row',
                        alignItems: 'center',
                    }}>
                    <Text style={{ color: Style.getColor('primary-text2'), fontSize: 16 }}>
                        Sort By
                    </Text>
                    <SortButton
                        sortType={SortType.RECENT}
                        currentSortType={sortType}
                        label="Recent"
                        onPress={() => {
                            setSortType(SortType.RECENT)
                            setCharacterList(characterList.sort(sortModified))
                        }}
                    />
                    <SortButton
                        sortType={SortType.ALPHABETICAL}
                        currentSortType={sortType}
                        label="A-z"
                        onPress={() => {
                            setSortType(SortType.ALPHABETICAL)
                            setCharacterList(characterList.sort(sortAlphabetical))
                        }}
                    />
                </View>

                <TouchableOpacity>
                    <FontAwesome name="search" color={Style.getColor('primary-text1')} size={28} />
                </TouchableOpacity>
            </View>

            {characterList.length === 0 && <CharactersEmpty />}

            {characterList.length !== 0 && (
                /*<ScrollView>
                    {characterList.map((character, index) => (
                        <CharacterListing
                            key={character.id}
                            index={index}
                            character={character}
                            nowLoading={nowLoading}
                            showTags={false}
                            setNowLoading={setNowLoading}
                        />
                    ))}
                </ScrollView>*/
                <Animated.FlatList
                    itemLayoutAnimation={SequencedTransition}
                    data={characterList}
                    keyExtractor={(item) => item.id.toString()}
                    renderItem={({ item, index }) => (
                        <CharacterListing
                            key={item.id}
                            index={index}
                            character={item}
                            nowLoading={nowLoading}
                            showTags={false}
                            setNowLoading={setNowLoading}
                        />
                    )}
                />
            )}
        </SafeAreaView>
    )
}

export default CharacterList

const styles = StyleSheet.create({
    sortButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: Style.getColor('primary-surface2'),
        borderRadius: 16,
    },

    sortButtonText: {
        color: Style.getColor('primary-text2'),
    },

    sortButtonActive: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: Style.getColor('primary-surface3'),
        borderRadius: 16,
    },

    sortButtonTextActive: {
        color: Style.getColor('primary-text1'),
    },
})
