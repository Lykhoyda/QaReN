import React from 'react';
import { View, Text, Pressable } from 'react-native';

export function Example() {
  return (
    <View testID="example-screen">
      <Text testID="title-text">Hello</Text>
      <Pressable testID="submit-btn" onPress={() => {}}>
        <Text>Submit</Text>
      </Pressable>
      <View testID={'dynamic-view'}>
        <Text>No testID here</Text>
      </View>
    </View>
  );
}
